from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any

import re

@dataclass
class ModuleParams:
    p_stc_w: Optional[float] = None
    gamma_pmp_per_c: Optional[float] = None  # -0.0035 per C typical
    bifaciality: Optional[float] = None

@dataclass
class InverterParams:
    eff_nominal: Optional[float] = None  # 0..1
    pac_max_kw: Optional[float] = None

def _parse_keyvals(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        # PAN/OND often use "key=value" or "key : value"
        m = re.split(r"\s*(=|:)\s*", line, maxsplit=1)
        if len(m) >= 3:
            k = m[0].strip()
            v = m[2].strip()
            out[k.lower()] = v
    return out

def parse_pan_bytes(data: bytes) -> ModuleParams:
    txt = data.decode("utf-8", errors="ignore")
    kv = _parse_keyvals(txt)

    # Heuristics: map common PVsyst-ish keys
    def f(key: str) -> Optional[float]:
        if key not in kv:
            return None
        nums = re.findall(r"-?\d+(?:\.\d+)?", kv[key])
        return float(nums[0]) if nums else None

    p = ModuleParams()
    # STC power: "Pmpp" (W) or "pnom" etc
    p.p_stc_w = f("pmpp") or f("pnom") or f("p_stc") or f("pmp_stc")
    # temp coefficient of Pmpp: might be "%/°C" or "1/°C"
    gamma = f("mu_pmp") or f("gamma_pmp") or f("tempco_pmp") or f("tpcoeffpmax")
    if gamma is not None:
        # If expressed in %/C, convert to fraction
        if abs(gamma) > 0.05:
            gamma = gamma / 100.0
        p.gamma_pmp_per_c = gamma
    p.bifaciality = f("bifaciality") or f("bif_factor")
    return p

def parse_ond_bytes(data: bytes) -> InverterParams:
    txt = data.decode("utf-8", errors="ignore")
    kv = _parse_keyvals(txt)

    def f(key: str) -> Optional[float]:
        if key not in kv:
            return None
        nums = re.findall(r"-?\d+(?:\.\d+)?", kv[key])
        return float(nums[0]) if nums else None

    inv = InverterParams()
    eff = f("eff") or f("effnom") or f("eff_nominal") or f("eta") or f("efficiency")
    if eff is not None:
        inv.eff_nominal = eff / 100.0 if eff > 1.5 else eff
    pac = f("pac") or f("pacmax") or f("p_ac") or f("pmaxac") or f("p_ac_nom")
    if pac is not None:
        # if given in W convert to kW if huge
        inv.pac_max_kw = pac / 1000.0 if pac > 5000 else pac
    return inv
