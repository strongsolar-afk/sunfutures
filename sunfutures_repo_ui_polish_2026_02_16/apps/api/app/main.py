from __future__ import annotations

import os
import uuid
import math
from pathlib import Path
from typing import List, Optional, Literal, Dict, Any, Tuple

import aiofiles
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app import auth, cache, storage, equipment
from app import gefs, reporting

import httpx
import numpy as np
import pandas as pd
import pytz
from dateutil import parser as dtparse
from fastapi import FastAPI, UploadFile, File, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict

import pvlib

APP_NAME = "SunFutures API"
UPLOAD_DIR = Path(os.environ.get("SUNFUTURES_UPLOAD_DIR", "./data/uploads")).resolve()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=APP_NAME, version="0.4.0")

# Rate limiting (in-memory by default; use REDIS by setting SUNFUTURES_REDIS_URL)
limiter = Limiter(key_func=get_remote_address, default_limits=[os.environ.get('SUNFUTURES_RATE_LIMIT', '60/minute')])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda r, e: HTTPException(status_code=429, detail='Rate limit exceeded'))
app.add_middleware(SlowAPIMiddleware)


cors = os.environ.get("SUNFUTURES_CORS_ORIGINS")
origins = [o.strip() for o in cors.split(",")] if cors else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Models ----------
class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    elevation_m: Optional[float] = Field(default=None, ge=-500, le=9000)

class EquipmentFileRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["PAN", "OND", "OTHER"]
    filename: str
    file_id: str

class Losses(BaseModel):
    model_config = ConfigDict(extra="forbid")
    soiling_pct: float = Field(default=2.0, ge=0, le=30)
    snow_pct: float = Field(default=0.0, ge=0, le=50)
    mismatch_pct: float = Field(default=1.5, ge=0, le=10)
    dc_wiring_pct: float = Field(default=1.0, ge=0, le=10)
    ac_wiring_pct: float = Field(default=0.5, ge=0, le=10)
    iam_pct: float = Field(default=2.0, ge=0, le=10)
    aux_pct: float = Field(default=0.5, ge=0, le=10)
    availability_pct: float = Field(default=99.0, ge=80, le=100)

class SimplePlantConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_name: str = "SunFutures Plant"
    dc_capacity_kw: float = Field(..., gt=0)
    ac_capacity_kw: float = Field(..., gt=0)
    mounting: Literal["FIXED", "SAT"] = "SAT"
    tilt_deg: Optional[float] = Field(default=None, ge=0, le=90)
    azimuth_deg: Optional[float] = Field(default=None, ge=0, le=360)
    gcr: float = Field(default=0.35, ge=0.1, le=0.9)
    max_tracker_angle_deg: float = Field(default=60, ge=0, le=90)
    backtracking: bool = True
    poi_limit_kw: Optional[float] = Field(default=None, gt=0)

class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: Location
    plant: SimplePlantConfig
    losses: Losses
    equipment_files: List[EquipmentFileRef] = []

class DailyKwh(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: str
    kwh: float

class ForecastResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    daily_kwh: List[DailyKwh]
    sources_used: Dict[str, Any]
    notes: List[str]

# ---------- Helpers ----------
def _parse_mph(s: str) -> float:
    # "10 mph" or "5 to 10 mph"
    nums = [float(x) for x in __import__("re").findall(r"\d+(?:\.\d+)?", s)]
    if not nums:
        return 0.0
    return float(sum(nums) / len(nums))

def _cloud_from_text(short_forecast: str) -> float:
    t = (short_forecast or "").lower()
    # crude mapping for when skyCover isn't provided
    if "sunny" in t or "clear" in t:
        return 5.0
    if "mostly sunny" in t:
        return 20.0
    if "partly sunny" in t or "partly cloudy" in t:
        return 40.0
    if "mostly cloudy" in t:
        return 70.0
    if "cloudy" in t or "overcast" in t:
        return 90.0
    if "rain" in t or "showers" in t or "thunder" in t:
        return 85.0
    return 50.0

def _kt_from_cloud(cloud_pct: np.ndarray) -> np.ndarray:
    # Empirical relation (crude but stable): clouds reduce clearness index strongly
    c = np.clip(cloud_pct / 100.0, 0.0, 1.0)
    kt = 1.0 - 0.75 * (c ** 3.4)
    return np.clip(kt, 0.05, 1.0)

async def _fetch_nws_hourly(lat: float, lon: float) -> Tuple[pd.DataFrame, str, Dict[str, Any]]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        p = await client.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
        if p.status_code != 200:
            raise HTTPException(status_code=502, detail=f"NWS points lookup failed: {p.status_code} {p.text[:200]}")
        pj = p.json()
        props = pj.get("properties", {})
        tz = props.get("timeZone") or "UTC"
        hourly_url = props.get("forecastHourly")
        if not hourly_url:
            raise HTTPException(status_code=502, detail="NWS response missing forecastHourly URL")

        h = await client.get(hourly_url)
        if h.status_code != 200:
            raise HTTPException(status_code=502, detail=f"NWS hourly forecast failed: {h.status_code} {h.text[:200]}")
        hj = h.json()
        periods = hj.get("properties", {}).get("periods", [])
        if not periods:
            raise HTTPException(status_code=502, detail="NWS hourly forecast empty")

    rows = []
    for per in periods:
        start = per.get("startTime")
        if not start:
            continue
        dt = dtparse.isoparse(start)
        temp_c = (float(per.get("temperature", 0.0)) - 32.0) * (5.0 / 9.0) if per.get("temperatureUnit") == "F" else float(per.get("temperature", 0.0))
        wind_mps = _parse_mph(per.get("windSpeed", "")) * 0.44704
        sky = per.get("skyCover")
        if sky is None:
            sky = _cloud_from_text(per.get("shortForecast", ""))
        rows.append({
            "time": dt,
            "temp_c": temp_c,
            "wind_mps": wind_mps,
            "cloud_pct": float(sky),
        })

    df = pd.DataFrame(rows).dropna(subset=["time"]).set_index("time").sort_index()
    meta = {
        "provider": "NOAA/NWS api.weather.gov",
        "hourly_url": hourly_url,
        "timezone": tz,
        "n_hours": int(df.shape[0]),
    }
    return df, tz, meta


def _expand_valid_time_series(items: list[dict], tz: str, value_key: str = "value") -> pd.Series:
    """Expand NWS grid validTime ranges into an hourly series.

    NWS grid items look like:
      {"validTime": "2026-02-14T18:00:00+00:00/PT1H", "value": 23}
    Duration can be >1H; we forward-fill across the range.
    """
    try:
        tzinfo = pytz.timezone(tz)
    except Exception:
        tzinfo = pytz.UTC

    points = {}
    for it in items or []:
        vt = it.get("validTime")
        val = it.get(value_key)
        if vt is None or val is None:
            continue
        try:
            start_str, dur_str = vt.split("/")
            start = dtparse.isoparse(start_str)
            # Parse ISO 8601 duration like PT1H / PT3H
            hours = 1
            md = __import__("re").search(r"PT(?:(\d+)H)?(?:(\d+)M)?", dur_str)
            if md:
                h = md.group(1)
                m2 = md.group(2)
                hours = int(h) if h else 0
                mins = int(m2) if m2 else 0
                hours = max(1, hours + (1 if mins >= 30 else 0))
            for k in range(hours):
                t = (start + pd.Timedelta(hours=k)).astimezone(tzinfo)
                points[pd.Timestamp(t)] = float(val)
        except Exception:
            continue

    if not points:
        return pd.Series(dtype=float)
    ser = pd.Series(points).sort_index()
    # Regularize to hourly index
    idx = pd.date_range(ser.index.min().ceil("H"), ser.index.max().floor("H"), freq="H", tz=ser.index.tz)
    ser = ser.reindex(idx).ffill()
    return ser


async def _fetch_nws_grid(lat: float, lon: float) -> Tuple[pd.DataFrame, str, Dict[str, Any]]:
    """Fetch NOAA/NWS forecastGridData (often considered NDFD-derived) for refined hourly variables."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        p = await client.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
        if p.status_code != 200:
            raise HTTPException(status_code=502, detail=f"NWS points lookup failed: {p.status_code} {p.text[:200]}")
        pj = p.json()
        props = pj.get("properties", {})
        tz = props.get("timeZone") or "UTC"
        grid_url = props.get("forecastGridData")
        if not grid_url:
            raise HTTPException(status_code=502, detail="NWS response missing forecastGridData URL")

        g = await client.get(grid_url)
        if g.status_code != 200:
            raise HTTPException(status_code=502, detail=f"NWS grid forecast failed: {g.status_code} {g.text[:200]}")
        gj = g.json()

    pr = gj.get("properties", {})
    temp_items = pr.get("temperature", {}).get("values", [])
    wind_items = pr.get("windSpeed", {}).get("values", [])
    sky_items = pr.get("skyCover", {}).get("values", [])

    temp = _expand_valid_time_series(temp_items, tz)
    wind = _expand_valid_time_series(wind_items, tz)
    sky = _expand_valid_time_series(sky_items, tz)

    # Units: temperature is degC, skyCover is %, windSpeed is typically km/h in NWS grid (unitCode "wmoUnit:km_h-1")
    if not wind.empty:
        wind_mps = wind / 3.6
    else:
        wind_mps = wind

    # Align on common hourly index
    idx = temp.index
    for ser in [wind_mps, sky]:
        if not ser.empty:
            idx = idx.union(ser.index)
    idx = idx.sort_values()

    df = pd.DataFrame(index=idx)
    if not temp.empty:
        df["temp_c"] = temp.reindex(idx).astype(float)
    if not wind_mps.empty:
        df["wind_mps"] = wind_mps.reindex(idx).astype(float)
    if not sky.empty:
        df["cloud_pct"] = sky.reindex(idx).astype(float)

    df = df.dropna(how="all").sort_index()
    meta = {
        "provider": "NOAA/NWS api.weather.gov forecastGridData (NDFD-derived)",
        "grid_url": pr.get("forecastGridData") or None,
        "timezone": tz,
        "n_hours": int(df.shape[0]),
    }
    return df, tz, {"provider": "NOAA/NWS api.weather.gov", "grid_url": pr.get("forecastGridData")}


def _blend_hourly(primary: pd.DataFrame, refined: pd.DataFrame, prefer_hours: int = 168) -> pd.DataFrame:
    """Blend two hourly datasets. Prefer refined values for the first prefer_hours hours if present."""
    if primary.empty:
        return refined
    if refined.empty:
        return primary

    idx = primary.index.union(refined.index).sort_values()
    out = primary.reindex(idx)
    ref = refined.reindex(idx)

    start = idx.min()
    cutoff = start + pd.Timedelta(hours=prefer_hours)
    mask = (idx >= start) & (idx < cutoff)

    for col in ["temp_c", "wind_mps", "cloud_pct"]:
        if col not in out.columns:
            out[col] = np.nan
        if col in ref.columns:
            # Use refined where available in the preferred window
            out.loc[mask, col] = ref.loc[mask, col].combine_first(out.loc[mask, col])
            # Outside window, keep primary unless primary missing
            out.loc[~mask, col] = out.loc[~mask, col].combine_first(ref.loc[~mask, col])

    return out.dropna(subset=["temp_c", "wind_mps", "cloud_pct"], how="all").sort_index()

def _pv_from_weather(
    df: pd.DataFrame,
    tz: str,
    lat: float,
    lon: float,
    elevation_m: float | None,
    plant: SimplePlantConfig,
    losses: Losses,
    module_params: equipment.ModuleParams | None = None,
    inverter_params: equipment.InverterParams | None = None,
) -> pd.DataFrame:
    # Ensure timezone-aware index
    if df.index.tzinfo is None:
        df = df.tz_localize("UTC")
    try:
        tzinfo = pytz.timezone(tz)
    except Exception:
        tzinfo = pytz.UTC
    df = df.tz_convert(tzinfo)

    # Create PVLib location
    loc = pvlib.location.Location(latitude=lat, longitude=lon, tz=tzinfo, altitude=elevation_m)

    times = df.index
    solpos = loc.get_solarposition(times)

    # Clear-sky (Ineichen); pvlib will estimate Linke turbidity if available
    cs = loc.get_clearsky(times, model="ineichen")  # ghi, dni, dhi (W/m2)

    cloud = df["cloud_pct"].to_numpy(dtype=float)
    kt = _kt_from_cloud(cloud)
    ghi = (cs["ghi"].to_numpy(dtype=float) * kt)

    # Decompose to DNI/DHI using Erbs
    erbs = pvlib.irradiance.erbs(pd.Series(ghi, index=times), solpos["zenith"], times)
    dhi = erbs["dhi"].to_numpy(dtype=float)
    dni = erbs["dni"].to_numpy(dtype=float)

    # Plane of array
    if plant.mounting == "SAT":
        tracking = pvlib.tracking.singleaxis(
            apparent_zenith=solpos["apparent_zenith"],
            apparent_azimuth=solpos["azimuth"],
            axis_tilt=0,
            axis_azimuth=0,  # N-S axis
            max_angle=plant.max_tracker_angle_deg,
            backtrack=plant.backtracking,
            gcr=plant.gcr,
        )
        surface_tilt = tracking["surface_tilt"].fillna(0)
        surface_azimuth = tracking["surface_azimuth"].fillna(180)
    else:
        surface_tilt = plant.tilt_deg if plant.tilt_deg is not None else 20.0
        surface_azimuth = plant.azimuth_deg if plant.azimuth_deg is not None else 180.0

    poa = pvlib.irradiance.get_total_irradiance(
        surface_tilt=surface_tilt,
        surface_azimuth=surface_azimuth,
        dni=dni,
        ghi=ghi,
        dhi=dhi,
        solar_zenith=solpos["apparent_zenith"],
        solar_azimuth=solpos["azimuth"],
        model="perez",
    )
    poa_global = poa["poa_global"].to_numpy(dtype=float)

    # Module temperature (simple SAPM)
    temp_air = df["temp_c"].to_numpy(dtype=float)
    wind = np.clip(df["wind_mps"].to_numpy(dtype=float), 0.0, 25.0)
    temp_cell = pvlib.temperature.sapm_cell(poa_global, temp_air, wind, a=-3.56, b=-0.075, deltaT=3)

    # DC power model (generic, since we aren't parsing .PAN yet)
    # Pdc ~ Pdc_stc * (poa/1000) * (1 + gamma*(Tcell-25C))
    gamma = (module_params.gamma_pmp_per_c if module_params and module_params.gamma_pmp_per_c is not None else -0.0035)  # per C
    pdc_kw = plant.dc_capacity_kw * (poa_global / 1000.0) * (1.0 + gamma * (temp_cell - 25.0))
    pdc_kw = np.clip(pdc_kw, 0.0, None)

    # Inverter (generic efficiency + clipping)
    inv_eff = (inverter_params.eff_nominal if inverter_params and inverter_params.eff_nominal is not None else 0.985)
    pac_kw = pdc_kw * inv_eff
    ac_limit = plant.ac_capacity_kw
    if inverter_params and inverter_params.pac_max_kw is not None:
        ac_limit = min(ac_limit, inverter_params.pac_max_kw)
    pac_kw = np.minimum(pac_kw, ac_limit)

    # Apply loss tree (treat as multiplicative)
    loss_frac = (
        losses.soiling_pct +
        losses.snow_pct +
        losses.mismatch_pct +
        losses.dc_wiring_pct +
        losses.ac_wiring_pct +
        losses.iam_pct +
        losses.aux_pct
    ) / 100.0
    availability = losses.availability_pct / 100.0
    pac_kw = pac_kw * max(0.0, (1.0 - loss_frac)) * availability

    # POI limit (kW)
    if plant.poi_limit_kw:
        pac_kw = np.minimum(pac_kw, plant.poi_limit_kw)

    out = pd.DataFrame(index=times)
    out["pac_kw"] = pac_kw
    out["poa_wm2"] = poa_global
    out["cloud_pct"] = cloud
    out["temp_c"] = temp_air
    out["wind_mps"] = wind
    return out

def _daily_kwh(pac_kw_series: pd.Series) -> List[Dict[str, Any]]:
    # Convert to kWh over each hour step (handle uneven)
    s = pac_kw_series.copy()
    if s.index.tzinfo is None:
        s = s.tz_localize("UTC")
    # energy per interval
    dt_hours = s.index.to_series().diff().dt.total_seconds().fillna(3600) / 3600.0
    e_kwh = (s * dt_hours).rename("kwh")
    daily = e_kwh.resample("D").sum()
    # Return next 30 days starting tomorrow (if exists)
    return [{"date": d.date().isoformat(), "kwh": float(round(v, 2))} for d, v in daily.items()]


def _probabilistic_daily(
    df_wx: pd.DataFrame,
    tz: str,
    lat: float,
    lon: float,
    elevation_m: float | None,
    plant: SimplePlantConfig,
    losses: Losses,
    module_params: equipment.ModuleParams | None = None,
    inverter_params: equipment.InverterParams | None = None,
    n: int = 40,
    seed: int = 7,
) -> Dict[str, List[Dict[str, Any]]]:
    """Monte Carlo bands around the deterministic weather forecast.

    This is a pragmatic bridge until true ensemble sources (e.g., GEFS/NDFD) are integrated.
    We perturb cloud cover and temperature/wind slightly, run the PV model N times,
    then compute daily percentiles.
    """
    rng = np.random.default_rng(seed)

    base = df_wx.copy()
    cloud = base["cloud_pct"].to_numpy(dtype=float)
    temp = base["temp_c"].to_numpy(dtype=float)
    wind = base["wind_mps"].to_numpy(dtype=float)

    # Uncertainty grows with forecast lead time (hours ahead)
    hours_ahead = (base.index - base.index.min()).total_seconds() / 3600.0
    # cloud sigma from 8% near-term to 22% long-term
    cloud_sigma = 8.0 + (22.0 - 8.0) * np.clip(hours_ahead / (24.0 * 7.0), 0.0, 1.0)
    # temp sigma 1C to 3C
    temp_sigma = 1.0 + (3.0 - 1.0) * np.clip(hours_ahead / (24.0 * 7.0), 0.0, 1.0)
    # wind sigma 0.5 to 1.5 m/s
    wind_sigma = 0.5 + (1.5 - 0.5) * np.clip(hours_ahead / (24.0 * 7.0), 0.0, 1.0)

    daily_runs = []
    for _ in range(n):
        df = base.copy()
        df["cloud_pct"] = np.clip(cloud + rng.normal(0.0, cloud_sigma), 0.0, 100.0)
        df["temp_c"] = temp + rng.normal(0.0, temp_sigma)
        df["wind_mps"] = np.clip(wind + rng.normal(0.0, wind_sigma), 0.0, 25.0)

        pv = _pv_from_weather(df, tz, lat, lon, elevation_m, plant, losses)
        d = _daily_kwh(pv["pac_kw"])
        # keep to same length by date
        daily_runs.append(pd.Series({x["date"]: x["kwh"] for x in d}))

    mat = pd.concat(daily_runs, axis=1).sort_index()
    # percentiles along columns (runs)
    p10 = mat.quantile(0.10, axis=1)
    p50 = mat.quantile(0.50, axis=1)
    p90 = mat.quantile(0.90, axis=1)

    def ser_to_list(ser: pd.Series) -> List[Dict[str, Any]]:
        return [{"date": str(idx), "kwh": float(round(val, 2))} for idx, val in ser.items()]

    return {"p10": ser_to_list(p10), "p50": ser_to_list(p50), "p90": ser_to_list(p90)}

# ---------- Endpoints ----------
@app.get("/health")
def health():
    return {"ok": True, "name": APP_NAME, "version": app.version}

@app.post("/v1/uploads")
@limiter.limit(os.environ.get("SUNFUTURES_RATE_LIMIT_UPLOAD", "20/minute"))
async def upload_files(
    files: List[UploadFile] = File(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
):
    auth.authenticate(x_api_key, authorization)

    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    results = []
    for f in files:
        file_id = uuid.uuid4().hex
        safe_name = Path(f.filename).name

        data = await f.read()
        storage_meta = storage.put_bytes(file_id, safe_name, data)

        ext = (Path(safe_name).suffix or "").lower()
        kind = "OTHER"
        if ext == ".pan":
            kind = "PAN"
        elif ext == ".ond":
            kind = "OND"

        results.append({
            "file_id": file_id,
            "filename": safe_name,
            "kind": kind,
            "size_bytes": len(data),
            "storage": storage_meta,
        })

    return {"uploaded": results}

@app.post("/v1/forecast", response_model=ForecastResponse)
@limiter.limit(os.environ.get("SUNFUTURES_RATE_LIMIT_FORECAST", "30/minute"))
async def forecast(
    req: ForecastRequest,
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
):
    principal = auth.authenticate(x_api_key, authorization)

    # Cache key (includes location + plant + losses + equipment refs)
    cache_key = cache.make_key("forecast:v1", {
        "lat": req.location.lat,
        "lon": req.location.lon,
        "elev": req.location.elevation_m,
        "plant": req.plant.model_dump(),
        "losses": req.losses.model_dump(),
        "equipment": [e.model_dump() for e in req.equipment_files],
    })
    cached = cache.get_json(cache_key)
    if cached:
        return ForecastResponse(**cached)

    # 1) Fetch NOAA/NWS hourly forecast (typically up to ~7 days)
    df_wx, tz, meta = await _fetch_nws_hourly(req.location.lat, req.location.lon)

    # Equipment parameters (optional). If uploaded, parse and use to refine gamma/eff limits.
    module_params = equipment.ModuleParams()
    inverter_params = equipment.InverterParams()
    for ef in req.equipment_files:
        data = storage.get_bytes(ef.file_id, ef.filename)
        if not data:
            continue
        if ef.kind == "PAN":
            module_params = equipment.parse_pan_bytes(data)
        elif ef.kind == "OND":
            inverter_params = equipment.parse_ond_bytes(data)

    # 2) Run PV performance model to compute hourly AC power
    pv = _pv_from_weather(
        df_wx,
        tz=tz,
        lat=req.location.lat,
        lon=req.location.lon,
        elevation_m=req.location.elevation_m,
        plant=req.plant,
        losses=req.losses,
        module_params=module_params,
        inverter_params=inverter_params,
    )

    # 3) Build daily kWh (P50). Also compute probabilistic bands via Monte Carlo perturbations.
    bands = _probabilistic_daily(df_wx, tz, req.location.lat, req.location.lon, req.location.elevation_m, req.plant, req.losses, module_params=module_params, inverter_params=inverter_params)
    daily = bands["p50"]

    notes = []
    sources_used = {
        "weather": meta,
        "irradiance": {"model": "clearsky(ineichen) * cloud->kt + erbs decomposition"},
        "pv": {"dc_model": "generic temp-derated", "inverter": "generic eff+clipping"},
        "probabilistic": {"method": "monte_carlo_perturbations", "n": 40, "series": bands},
    }

    if len(daily) < 30:
        notes.append(f"NWS hourly forecast only covered {len(daily)} days; extended to 30 days with a climatology-lite fallback.")
        # Extend: repeat last 48h mean cloud as persistence, on top of clearsky
        # Create hourly times for remaining days in the same tz
        tzinfo = pv.index.tz
        last_time = pv.index.max()
        start = (last_time + pd.Timedelta(hours=1)).ceil("H")
        end = (start + pd.Timedelta(days=(30 - len(daily))) )
        times = pd.date_range(start=start, end=end, freq="H", tz=tzinfo, inclusive="left")

        # persistence cloud
        cloud_persist = float(pd.Series(pv["cloud_pct"]).tail(48).mean()) if pv.shape[0] >= 24 else 50.0
        # Build synthetic weather frame
        df2 = pd.DataFrame(index=times)
        df2["cloud_pct"] = cloud_persist
        df2["temp_c"] = float(pd.Series(pv["temp_c"]).tail(48).mean()) if pv.shape[0] else 20.0
        df2["wind_mps"] = float(pd.Series(pv["wind_mps"]).tail(48).mean()) if pv.shape[0] else 2.0

        # Extend probabilistic bands using the persistence frame
        bands2 = _probabilistic_daily(df2, tz, req.location.lat, req.location.lon, req.location.elevation_m, req.plant, req.losses, module_params=module_params, inverter_params=inverter_params, n=20, seed=11)
        daily2 = bands2["p50"]

        def _append_trunc(a, b):
            return (a + b)[:30]

        bands["p10"] = _append_trunc(bands["p10"], bands2["p10"])
        bands["p50"] = _append_trunc(bands["p50"], bands2["p50"])
        bands["p90"] = _append_trunc(bands["p90"], bands2["p90"])
        daily = bands["p50"]

    else:
        daily = daily[:30]

    notes.extend([
        "This is a real forecast pipeline for days covered by NOAA/NWS hourly forecasts.",
        "To match your original spec (NCEI/CPC/WPC/NDFD fusion), add additional provider modules and a reliability blender.",
        "Equipment (.PAN/.OND) uploads are stored but not yet parsed; PV model currently uses generic module/inverter assumptions."
    ])

    resp = ForecastResponse(
        daily_kwh=[DailyKwh(**d) for d in daily],
        sources_used=sources_used,
        notes=notes,
    )
    cache.set_json(cache_key, resp.model_dump())
    return resp


@app.post('/v1/token')
@limiter.limit('10/minute')
def issue_token(sub: str, plan: str = 'standard', x_api_key: str | None = Header(default=None, alias='X-API-Key')):
    # For development / internal use. Protect by API key.
    if not auth.API_KEY or x_api_key != auth.API_KEY:
        raise HTTPException(status_code=401, detail='Unauthorized')
    return {'token': auth.mint_token(sub=sub, plan=plan)}


@app.post('/v1/report')
@limiter.limit(os.environ.get('SUNFUTURES_RATE_LIMIT_REPORT', '20/minute'))
async def report(req: ForecastRequest, x_api_key: str | None = Header(default=None, alias='X-API-Key'), authorization: str | None = Header(default=None, alias='Authorization')):
    auth.authenticate(x_api_key, authorization)
    # Reuse forecast pipeline, but also return PVsyst-style reporting blocks.
    # (We call internal functions directly for speed; report output is additive and does not change /v1/forecast.)
    df_hourly, tz, meta_hourly = await _fetch_nws_hourly(req.location.lat, req.location.lon)
    try:
        df_grid, tz2, meta_grid = await _fetch_nws_grid(req.location.lat, req.location.lon)
    except Exception:
        df_grid, tz2, meta_grid = pd.DataFrame(), tz, {}
    if tz2 != tz and not df_grid.empty:
        df_grid = df_grid.tz_convert(pytz.timezone(tz)) if df_grid.index.tz is not None else df_grid
    df_wx = _blend_hourly(df_hourly, df_grid, prefer_hours=168)

    module_params = equipment.ModuleParams()
    inverter_params = equipment.InverterParams()
    for ef in req.equipment_files:
        data = storage.get_bytes(ef.file_id, ef.filename)
        if not data:
            continue
        if ef.kind == 'PAN':
            module_params = equipment.parse_pan_bytes(data)
        elif ef.kind == 'OND':
            inverter_params = equipment.parse_ond_bytes(data)

    pv = _pv_from_weather(df_wx, tz, req.location.lat, req.location.lon, req.location.elevation_m, req.plant, req.losses, module_params=module_params, inverter_params=inverter_params)
    daily = _daily_kwh(pv['pac_kw'])

    kpis = reporting.compute_kpis(pv, daily, dc_capacity_kw=req.plant.dc_capacity_kw)
    loss_tree = reporting.loss_tree_from_losses(req.losses.model_dump())

    return {
        'project': {
            'plant_name': req.plant.plant_name,
            'location': req.location.model_dump(),
            'dc_capacity_kw': req.plant.dc_capacity_kw,
            'ac_capacity_kw': req.plant.ac_capacity_kw,
        },
        'daily_kwh': daily,
        'kpis': kpis,
        'loss_diagram': loss_tree,
        'sources_used': {
            'weather': {'hourly': meta_hourly, 'grid': meta_grid, 'blend': {'prefer_hours': 168}},
            'pv': {'module_params': module_params.__dict__, 'inverter_params': inverter_params.__dict__},
        }
    }
