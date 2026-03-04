from uuid import uuid4
from django.core.cache import cache

SCRIPT_TOKEN_PREFIX = "script_token:"


def issue_script_token(payload: dict, timeout_seconds: int = 600) -> str:
    """Issue a one-time script token stored in Redis with a 10-minute TTL."""
    token = uuid4().hex
    cache.set(f"{SCRIPT_TOKEN_PREFIX}{token}", payload, timeout=timeout_seconds)
    return token


def pop_script_payload(token: str) -> dict | None:
    """Read and delete a one-time script token payload (atomic one-time use)."""
    key = f"{SCRIPT_TOKEN_PREFIX}{token}"
    payload = cache.get(key)
    if payload is not None:
        cache.delete(key)
    return payload
