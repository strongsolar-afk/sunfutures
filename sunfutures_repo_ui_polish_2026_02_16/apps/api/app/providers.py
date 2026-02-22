from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any, Tuple
import pandas as pd

@dataclass
class WeatherBundle:
    df_hourly: pd.DataFrame   # index: tz-aware timestamps; columns: temp_c, wind_mps, cloud_pct
    tz: str
    meta: Dict[str, Any]

# Provider interface
class WeatherProvider:
    name: str
    async def fetch(self, lat: float, lon: float) -> WeatherBundle:
        raise NotImplementedError

# NOTE:
# - Today we use NOAA/NWS api.weather.gov hourly as primary.
# - The architecture below is ready to add NDFD grids + WPC + CPC.
# - Implementations for CPC/WPC/NDFD can be added without changing API contract.
