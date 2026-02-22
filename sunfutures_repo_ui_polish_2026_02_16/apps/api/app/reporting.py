from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import pandas as pd
import numpy as np

# PVsyst-style KPIs (subset)
# PR formula documented by PVsyst: PR = E_Grid / (GlobInc * PnomPV)
# We'll compute a daily PR using POA irradiance as GlobInc proxy (kWh/m2/day), and PnomPV (kWp).

def compute_kpis(
    df_hourly: pd.DataFrame,
    daily_kwh: List[Dict[str, Any]],
    dc_capacity_kw: float,
) -> Dict[str, Any]:
    """Compute a PVsyst-style KPI block from hourly model internals.

    Expects df_hourly to include:
      - poa_wm2 (plane-of-array irradiance)
      - pac_kw (AC power)
    """
    out: Dict[str, Any] = {}
    if df_hourly.empty:
        return out

    # Daily POA irradiation (kWh/m2/day)
    poa_kwh_m2 = (df_hourly["poa_wm2"].clip(lower=0) / 1000.0).resample("D").sum()
    e_ac_kwh = (df_hourly["pac_kw"].clip(lower=0)).resample("D").sum()

    # Specific yield (kWh/kWp/day)
    y_spec = e_ac_kwh / max(1e-6, dc_capacity_kw)

    # Performance Ratio (daily) using PVsyst-style formula with POA as GlobInc proxy
    # PR = E_Grid / (GlobInc * PnomPV) where GlobInc in kWh/m2 and PnomPV in kWp
    pr = e_ac_kwh / (poa_kwh_m2 * max(1e-6, dc_capacity_kw))

    out["daily"] = []
    for date, e in e_ac_kwh.items():
        d = str(date.date())
        out["daily"].append({
            "date": d,
            "poa_kwh_m2": float(round(poa_kwh_m2.get(date, np.nan), 4)),
            "e_ac_kwh": float(round(e, 2)),
            "specific_yield_kwh_per_kwp": float(round(y_spec.get(date, np.nan), 4)),
            "pr": float(round(pr.get(date, np.nan), 4)),
        })

    # Summary
    out["summary"] = {
        "total_kwh": float(round(float(e_ac_kwh.sum()), 2)),
        "avg_pr": float(round(float(np.nanmean(pr.values)), 4)),
        "avg_specific_yield_kwh_per_kwp_day": float(round(float(np.nanmean(y_spec.values)), 4)),
    }
    return out

def loss_tree_from_losses(losses: Dict[str, float]) -> Dict[str, Any]:
    """Return a PVsyst-like loss diagram structure from the loss sliders."""
    # Order inspired by PVsyst loss diagram categories (optical -> array -> system).
    order = [
        ("Soiling", losses.get("soiling_pct", 0.0)),
        ("IAM", losses.get("iam_pct", 0.0)),
        ("Snow", losses.get("snow_pct", 0.0)),
        ("Mismatch", losses.get("mismatch_pct", 0.0)),
        ("DC wiring", losses.get("dc_wiring_pct", 0.0)),
        ("AC wiring", losses.get("ac_wiring_pct", 0.0)),
        ("Aux consumption", losses.get("aux_pct", 0.0)),
        ("Availability", 100.0 - losses.get("availability_pct", 100.0)),
    ]
    return {"items": [{"name": n, "loss_pct": float(v)} for n, v in order]}
