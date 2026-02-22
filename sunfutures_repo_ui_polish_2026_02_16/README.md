# SunFutures

Utility-scale PV energy forecasting with an iPhone client (Apple Maps) and a hosted forecasting API (Fly.io).

## Repo layout

- `apps/api` — FastAPI forecasting API (Dockerized; deployable to Fly.io)
- `apps/mobile` — iOS app (Expo React Native) with Apple Maps site picker
- `packages/contracts` — shared API contract (JSON schemas + example payloads)
- `infra/fly` — Fly.io deployment notes/templates
- `docs` — documentation (architecture, operations)
- `scripts` — developer scripts (format, lint, local run)

## Quick start (local)

### API
```bash
cd apps/api
python -m venv .venv
.venv\Scripts\activate
pip install -e .
uvicorn app.main:app --reload --port 8000
```

### Mobile
```bash
cd apps/mobile
npm install
# point the app to your API:
export EXPO_PUBLIC_API_BASE=http://localhost:8000
npx expo run:ios
```

## Deploy API to Fly.io

Set required secrets (NWS requires User-Agent w/ contact):
```bash
cd apps/api
fly launch --name sunfutures-api --no-deploy
fly volumes create uploads --size 10
fly secrets set SUNFUTURES_API_KEY=YOUR_SECRET
fly secrets set SUNFUTURES_USER_AGENT="SunFutures/0.3 (contact: ops@yourdomain.com)"
fly deploy
```

## Notes

- `/v1/forecast` is a **real** pipeline for the horizon covered by NOAA/NWS hourly forecasts.
- Equipment files (.PAN/.OND) are uploaded and stored; parsing them is a planned enhancement.


## Linting / formatting

### API
```bash
cd apps/api
pip install -e ".[dev]"
ruff check app
black --check app
mypy app
```

### Mobile
```bash
cd apps/mobile
npm install
npm run lint
npm run format:check
npm run typecheck
```


## Forecast output
- Mobile app displays kWh/day in a table.
- You can export the 30-day forecast to **CSV** from the Results screen (Share/Save).
- A simple line chart is shown for quick visual inspection.
