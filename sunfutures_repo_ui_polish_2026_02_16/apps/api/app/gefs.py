from __future__ import annotations

import os
from typing import Any, Dict, List, Tuple, Optional
import pandas as pd
import numpy as np
from dateutil import tz as dateutil_tz
from dateutil import parser as dtparse

# This module attempts to load true GEFS ensemble members for DSWRF (downward shortwave flux) and basic meteorology.
# Implementation uses NOAA Open Data bucket (s3://noaa-gefs-pds) and GRIB decoding via cfgrib.
#
# IMPORTANT: cfgrib requires the ECMWF ecCodes library at runtime. In many container environments, this may not be present.
# If cfgrib/eccodes are unavailable, the caller should fall back to the Monte-Carlo method.

GEFS_BUCKET = "noaa-gefs-pds"
GEFS_REGION = "us-east-1"

def _member_names(n: int = 21) -> List[str]:
    # GEFS typically: control 'c00' + perturbed 'p01'..'p20'
    out = ["c00"]
    for i in range(1, n):
        out.append(f"p{i:02d}")
    return out

def _nearest_grid_point(lat: float, lon: float, lats: np.ndarray, lons: np.ndarray) -> Tuple[int, int]:
    # lon normalization
    lon2 = lon % 360.0
    # simple nearest by squared distance in lat/lon space
    d = (lats - lat) ** 2 + (lons - lon2) ** 2
    idx = np.unravel_index(np.argmin(d), d.shape)
    return int(idx[0]), int(idx[1])

def fetch_gefs_ensemble_hourly(
    t0_utc: pd.Timestamp,
    lat: float,
    lon: float,
    horizon_hours: int = 168,
    variables: List[str] | None = None,
) -> Dict[str, Any]:
    """Fetch GEFS ensemble members for the first horizon_hours and return an hourly dataframe per member.

    Returns:
      {
        "members": { "c00": df, "p01": df, ... },
        "meta": {...}
      }

    Notes:
    - Uses AWS anonymous access to s3://noaa-gefs-pds.
    - Needs optional deps: xarray, s3fs, cfgrib, eccodes.
    - Reads DSWRF (surface downward shortwave flux averaged) when available.
    """
    variables = variables or ["dswrf", "t2m", "u10", "v10"]
    try:
        import s3fs  # type: ignore
        import xarray as xr  # type: ignore
    except Exception as e:
        raise RuntimeError(f"Missing optional GEFS deps (install extras [gefs]): {e}")

    # Anonymous S3
    fs = s3fs.S3FileSystem(anon=True, client_kwargs={"region_name": GEFS_REGION})

    cycle = t0_utc.strftime("%H")
    date = t0_utc.strftime("%Y%m%d")
    # GEFS path patterns vary by product; this code is a best-effort implementation.
    # Common pattern: gefs.YYYYMMDD/HH/atmos/pgrb2ap5/gepXX.tHHz.pgrb2a.0p50.fFFF
    # We try both control and perturb members.
    members = _member_names(21)

    # Forecast hours: GEFS provides 3-hourly after initial; we'll request 0..168 step 3 and interpolate to hourly.
    fhrs = list(range(0, horizon_hours + 1, 3))

    out_members: Dict[str, pd.DataFrame] = {}
    for mem in members:
        frames = []
        for fhr in fhrs:
            fff = f"{fhr:03d}"
            # Try a couple known key patterns
            keys = [
                f"{GEFS_BUCKET}/gefs.{date}/{cycle}/atmos/pgrb2ap5/ge{mem}.t{cycle}z.pgrb2a.0p50.f{fff}",
                f"{GEFS_BUCKET}/gefs.{date}/{cycle}/atmos/pgrb2s/ge{mem}.t{cycle}z.pgrb2s.0p25.f{fff}",
                f"{GEFS_BUCKET}/gefs.{date}/{cycle}/atmos/pgrb2ap5/ge{mem}.t{cycle}z.pgrb2a.0p50.f{fff}.idx",
            ]
            key = None
            for k in keys:
                if fs.exists(k):
                    key = k
                    break
            if not key or key.endswith(".idx"):
                continue

            # Open GRIB with cfgrib via fsspec file-like
            try:
                with fs.open(key, "rb") as f:
                    ds = xr.open_dataset(f, engine="cfgrib")
            except Exception:
                # Try passing path directly (some builds prefer this)
                try:
                    ds = xr.open_dataset(f"s3://{key}", engine="cfgrib", backend_kwargs={"storage_options": {"anon": True}})
                except Exception:
                    continue

            # Extract nearest grid point and vars
            # ds typically has latitude/longitude coords
            if "latitude" in ds.coords and "longitude" in ds.coords:
                lats = ds["latitude"].values
                lons = ds["longitude"].values
                # coords may be 1D or 2D
                if lats.ndim == 1 and lons.ndim == 1:
                    # mesh
                    ilat = int(np.argmin((lats - lat) ** 2))
                    ilon = int(np.argmin(((lons % 360.0) - (lon % 360.0)) ** 2))
                else:
                    ilat, ilon = _nearest_grid_point(lat, lon, lats, lons)

                row = {}
                # Try map variable names; GRIB shortNames might differ; best-effort.
                for v in variables:
                    cand = None
                    for name in ds.data_vars:
                        if v.lower() in name.lower():
                            cand = name
                            break
                    if cand:
                        val = ds[cand].values
                        if np.ndim(val) >= 2:
                            row[v] = float(val[ilat, ilon])
                        else:
                            row[v] = float(val.item())
                # Timestamp
                valid = t0_utc + pd.Timedelta(hours=fhr)
                row["time"] = valid
                frames.append(row)

        if not frames:
            continue
        df = pd.DataFrame(frames).set_index("time").sort_index()
        # Convert dswrf from W/m2 average over 3h -> keep as W/m2; we'll later integrate to energy.
        # Interpolate to hourly
        df = df.resample("1H").interpolate(limit_direction="both")
        out_members[mem] = df

    if not out_members:
        raise RuntimeError("No GEFS members could be loaded (bucket key patterns may differ or cfgrib not available)")

    return {
        "members": out_members,
        "meta": {
            "provider": "NOAA GEFS (Open Data S3)",
            "t0_utc": str(t0_utc),
            "members_loaded": list(out_members.keys()),
            "horizon_hours": horizon_hours,
            "note": "True ensemble when cfgrib/eccodes available; otherwise fallback is recommended.",
        },
    }
