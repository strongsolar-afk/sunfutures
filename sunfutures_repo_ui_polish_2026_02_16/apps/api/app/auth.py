from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional, Dict, Any

import jwt
from fastapi import Header, HTTPException

JWT_SECRET = os.environ.get("SUNFUTURES_JWT_SECRET")  # if set, enable bearer auth
JWT_ISSUER = os.environ.get("SUNFUTURES_JWT_ISSUER", "sunfutures")
JWT_AUDIENCE = os.environ.get("SUNFUTURES_JWT_AUDIENCE", "sunfutures-mobile")
JWT_ALG = "HS256"
JWT_TTL_SECONDS = int(os.environ.get("SUNFUTURES_JWT_TTL_SECONDS", "86400"))

# Legacy header API key (still supported)
API_KEY = os.environ.get("SUNFUTURES_API_KEY")

@dataclass
class Principal:
    sub: str
    plan: str = "standard"
    meta: Dict[str, Any] | None = None

def _require_api_key(x_api_key: str | None):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")

def _require_bearer(authorization: str | None) -> Principal:
    if not JWT_SECRET:
        # bearer auth disabled
        return Principal(sub="anonymous")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALG],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
            options={"require": ["exp", "iat", "sub"]},
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

    return Principal(sub=str(payload.get("sub")), plan=str(payload.get("plan", "standard")), meta=payload)

def authenticate(
    x_api_key: str | None,
    authorization: str | None,
) -> Principal:
    # If JWT is enabled, require bearer; else use API key (if configured).
    if JWT_SECRET:
        return _require_bearer(authorization)
    _require_api_key(x_api_key)
    return Principal(sub="api_key_user")

def mint_token(sub: str, plan: str = "standard") -> str:
    if not JWT_SECRET:
        raise RuntimeError("SUNFUTURES_JWT_SECRET is not set")
    now = int(time.time())
    payload = {
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "sub": sub,
        "plan": plan,
        "iat": now,
        "exp": now + JWT_TTL_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
