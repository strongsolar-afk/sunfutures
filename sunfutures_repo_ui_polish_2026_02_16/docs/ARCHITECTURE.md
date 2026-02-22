# Architecture

## Components
- iOS client: `apps/mobile` (Expo RN, Apple Maps)
- Forecasting API: `apps/api` (FastAPI, pvlib, NOAA/NWS hourly forecast ingestion)

## Data flow
1. Mobile sends `/v1/forecast` with location, plant, losses, uploaded equipment references.
2. API fetches NOAA/NWS hourly forecast for the location.
3. API converts cloud cover -> irradiance -> PV AC power -> daily kWh.
4. API returns 30 daily values. If NOAA horizon is shorter, API extends with a fallback.

## Planned upgrades
- Add additional NOAA sources (NDFD, WPC, CPC, NCEI) and a blending engine.
- Parse PVsyst `.PAN` / `.OND` for module/inverter parameters.
- Replace file volume storage with S3-compatible storage.
