from typing import List
import socket
from uuid import uuid4

from django.core.cache import cache

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
    # Find multiple free ports on the host.
    free_ports = []
    for port in range(1024, 65535):
        if len(free_ports) >= count:
            break
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))  # Try to bind to the port.
                free_ports.append(port)  # If successful, consider the port free.
                s.close()  # Close the socket.
            except socket.error:
                pass  # If bind fails, the port is in use, so ignore this port.

    if len(free_ports) < count:
        raise Exception("Not enough free ports available.")
    
    return free_ports