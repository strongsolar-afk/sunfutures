from __future__ import annotations

import os
import json
import hashlib
from typing import Any, Optional

import redis

REDIS_URL = os.environ.get("SUNFUTURES_REDIS_URL")  # e.g. redis://default:pass@host:6379/0
DEFAULT_TTL_SECONDS = int(os.environ.get("SUNFUTURES_CACHE_TTL_SECONDS", "900"))

_client: redis.Redis | None = None

def client() -> Optional[redis.Redis]:
    global _client
    if not REDIS_URL:
        return None
    if _client is None:
        _client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    return _client

def make_key(prefix: str, obj: Any) -> str:
    s = json.dumps(obj, sort_keys=True, separators=(",", ":"))
    h = hashlib.sha256(s.encode("utf-8")).hexdigest()
    return f"{prefix}:{h}"

def get_json(key: str) -> Any | None:
    c = client()
    if not c:
        return None
    v = c.get(key)
    if not v:
        return None
    return json.loads(v)

def set_json(key: str, value: Any, ttl: int = DEFAULT_TTL_SECONDS) -> None:
    c = client()
    if not c:
        return
    c.set(key, json.dumps(value, separators=(",", ":")), ex=ttl)
