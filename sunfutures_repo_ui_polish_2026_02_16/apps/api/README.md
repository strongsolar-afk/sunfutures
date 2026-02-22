# SunFutures API (Fly.io)

## Local run
```bash
cd sunfutures-api
python -m venv .venv
.venv\Scripts\activate
pip install -e .
uvicorn app.main:app --reload --port 8000
```

## Deploy to Fly.io
Prereqs: install flyctl, login (`fly auth login`)

```bash
cd sunfutures-api
fly launch --name sunfutures-api --no-deploy
fly volumes create uploads --size 10
fly secrets set SUNFUTURES_API_KEY=YOUR_SECRET
fly deploy
```

After deploy, you'll get a URL like:
- https://sunfutures-api.fly.dev


## NOAA/NWS requirement
Set `SUNFUTURES_USER_AGENT` (Fly secret/env) to a User-Agent with contact info, required by api.weather.gov.
Example:
`fly secrets set SUNFUTURES_USER_AGENT='SunFutures/0.3 (contact: ops@yourdomain.com)'`


## Production hardening (implemented)

### Redis cache (recommended)
Set:
- `SUNFUTURES_REDIS_URL=redis://...`
This enables caching for `/v1/forecast` responses.

### Rate limiting
Env:
- `SUNFUTURES_RATE_LIMIT` (default `60/minute`)
- `SUNFUTURES_RATE_LIMIT_FORECAST` (default `30/minute`)
- `SUNFUTURES_RATE_LIMIT_UPLOAD` (default `20/minute`)

### S3 uploads (optional)
If you set:
- `SUNFUTURES_S3_BUCKET`
uploads will be stored in S3 (or S3-compatible) instead of local disk.
Optional:
- `SUNFUTURES_S3_ENDPOINT_URL` (Cloudflare R2 / MinIO)
- `SUNFUTURES_S3_REGION`

### JWT auth (optional)
If you set:
- `SUNFUTURES_JWT_SECRET`
the API will require `Authorization: Bearer <token>` for requests.
You can mint a token for testing via `/v1/token` (protected by API key).

### Equipment parsing (.PAN/.OND)
Uploaded `.PAN` and `.OND` files are heuristically parsed to refine:
- module temperature coefficient (gamma)
- inverter nominal efficiency
- inverter AC max power (if provided)


### Days 1–7 accuracy upgrade
The API now blends `forecastGridData` (NDFD-derived) into `forecastHourly`, preferring grid values for the first 168 hours.


### True ensemble bands (GEFS)
Set `SUNFUTURES_GEFS=1` and install API extras `.[gefs]` to attempt loading GEFS ensemble members (DSWRF, etc.) from NOAA Open Data on AWS. If GEFS cannot be decoded in your environment, the API falls back to Monte Carlo perturbations.


### PVsyst-style reporting
`POST /v1/report` returns a PVsyst-inspired JSON report block including:
- daily POA irradiation, specific yield, PR
- a loss-diagram structure from the loss sliders
