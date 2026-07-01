"""
WebSocket 一次性連線票（ticket）。/ One-time WebSocket connection tickets.

流程 / Flow:
1. 前端以「已認證的 REST 請求」呼叫 POST /api/auth/ws-ticket（JWT 走 Authorization header，不進 URL/log）。
2. 後端產生一張短效、單次、亂數 ticket，存進 Redis（TTL=WS_TICKET_TTL），回傳給前端。
3. 前端以 subprotocol `ticket.<ticket>` 連 WebSocket；consumer 取出、驗證並「立即刪除」（單次使用）。

如此 JWT 不會出現在 WebSocket 的 subprotocol / URL 中，降低被 proxy / access log 記錄或外洩的風險；
且 ticket 短效單次，即使外洩也很快失效。

The one-time ticket keeps the JWT out of the WebSocket subprotocol/URL: the token only travels in the
Authorization header of the ticket request, and the WS carries only a short-lived, single-use ticket.
"""
import secrets

from django.core.cache import cache

WS_TICKET_TTL = 60  # 秒 / seconds — 足夠完成一次連線 / enough to complete one connect
_KEY_PREFIX = "ws_ticket:"


def issue_ticket(user_id: int) -> str:
    """產生一張綁定 user_id 的一次性 ticket，存入快取後回傳。/ Issue a single-use ticket bound to user_id."""
    ticket = secrets.token_urlsafe(32)
    cache.set(f"{_KEY_PREFIX}{ticket}", int(user_id), timeout=WS_TICKET_TTL)
    return ticket


def consume_ticket(ticket: str):
    """
    驗證並「用掉」一張 ticket：回傳綁定的 user_id；若無效/過期/已用過則回傳 None。
    Validate and consume a ticket: returns the bound user_id, or None if invalid/expired/already used.
    """
    if not ticket:
        return None
    key = f"{_KEY_PREFIX}{ticket}"
    user_id = cache.get(key)
    if user_id is None:
        return None
    cache.delete(key)  # 單次使用 / single-use
    return user_id
