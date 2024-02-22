from django.core.cache import cache
from uuid import uuid4

def issue_token() -> str:
    """生成一個token"""
    token = uuid4().hex
    cache.set(token, "valid", timeout=10 * 60)
    return token

def verify_token(token) -> bool:
    """驗證token是否存在（有效）"""
    return True if cache.get(token) else False
