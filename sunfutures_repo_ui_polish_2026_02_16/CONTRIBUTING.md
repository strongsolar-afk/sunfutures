# Contributing

## Development
- API: `cd apps/api && pip install -e ".[dev]" && uvicorn app.main:app --reload`
- Mobile: `cd apps/mobile && npm install && npx expo run:ios`

## Quality gates
- API: `ruff check app && black --check app && mypy app`
- Mobile: `npm run lint && npm run format:check && npm run typecheck`

## Pull requests
- Keep changes focused
- Include screenshots for UI changes
- Update docs/contracts when API changes
