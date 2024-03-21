from typing import List
import socket
from uuid import uuid4

from django.core.cache import cache

from authorized_keys.utils import get_ss_output_from_redis

def issue_token() -> str:
    """生成一個token"""
    token = uuid4().hex
    cache.set(token, "valid", timeout=10 * 60)
    return token

def verify_token(token:str) -> bool:
    """驗證token是否存在（有效）"""
    return True if cache.get(token) else False

def remove_token(token:str) -> None:
    """移除token"""
    cache.delete(token)


def find_multiple_free_ports(count: int) -> List[int]:
    # Use SSH connection to the remote server to check for used ports
    ports = get_ss_output_from_redis(filter=False)
    # Include off line ports
    used_ports = list(ports.keys())
    # Find the first `count` free ports
    free_ports = sorted(list(set(range(1024, 65535)) - set(used_ports)))[:count]

    if len(free_ports) < count:
        raise Exception("Not enough free ports available.")

    return free_ports