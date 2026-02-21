from typing import List, Union
from uuid import uuid4

from django.core.cache import cache
from django.contrib.auth.models import User
from authorized_keys.utils import get_ss_output_from_redis

def issue_token(user_id:int) -> str:
    """生成一個token，並將值設定為user_id，有效期10分鐘"""
    token = uuid4().hex
    cache.set(token, user_id, timeout=10 * 60)
    return token

def verify_token(token:str) -> bool:
    """驗證token是否存在（有效）"""
    return True if cache.get(token) else False

def get_user_id_from_token(token:str) -> Union[User, None]:
    """從token中取得user instance"""
    user_id = cache.get(token)
    try:
        return User.objects.get(id=user_id)
    except User.DoesNotExist:
        return None

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