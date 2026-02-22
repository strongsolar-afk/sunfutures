# Fly.io deployment

The API is deployed from `apps/api`.

Recommended:
- Use a volume for uploaded equipment files (or migrate to S3 later).
- Set `SUNFUTURES_USER_AGENT` with contact info (required by api.weather.gov).
- Set `SUNFUTURES_API_KEY` and configure the mobile app to send `X-API-Key`.

Commands (from `apps/api`):
```bash
fly launch --name sunfutures-api --no-deploy
fly volumes create uploads --size 10
fly secrets set SUNFUTURES_API_KEY=YOUR_SECRET
fly secrets set SUNFUTURES_USER_AGENT="SunFutures/0.3 (contact: ops@yourdomain.com)"
fly deploy
```


### Add-ons
- Redis: set `SUNFUTURES_REDIS_URL`
- S3 uploads: set `SUNFUTURES_S3_BUCKET` (+ optional endpoint/region)
- JWT auth: set `SUNFUTURES_JWT_SECRET`
