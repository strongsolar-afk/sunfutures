# Linting & formatting (API)

Install dev tools:
```bash
pip install -e ".[dev]"
```

Run:
```bash
ruff check apps/api/app
black --check apps/api/app
mypy apps/api/app
```

Auto-fix:
```bash
ruff check --fix apps/api/app
black apps/api/app
```
