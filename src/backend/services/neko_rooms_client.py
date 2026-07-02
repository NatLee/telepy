import os
import time
import logging
import requests

logger = logging.getLogger(__name__)


class NekoRoomsError(Exception):
    pass


class NekoRoomsClient:
    """neko-rooms REST API 薄封裝。後端於內網直接呼叫,不經 Traefik。"""

    def __init__(self, base_url=None, timeout=10):
        self.base_url = (base_url or os.getenv("NEKO_ROOMS_API", "http://neko-rooms:8080")).rstrip("/")
        self.timeout = timeout

    def _rooms_url(self, suffix=""):
        return f"{self.base_url}/api/rooms{suffix}"

    def create_room(self, settings: dict) -> dict:
        try:
            resp = requests.post(
                self._rooms_url(),
                params={"start": "true"},
                json=settings,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def get_room(self, room_id: str) -> dict:
        try:
            resp = requests.get(self._rooms_url(f"/{room_id}"), timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def delete_room(self, room_id: str) -> None:
        try:
            resp = requests.delete(self._rooms_url(f"/{room_id}"), timeout=self.timeout)
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def list_rooms(self, labels: dict = None) -> list:
        try:
            resp = requests.get(self._rooms_url(), params=labels or {}, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json() or []
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def wait_ready(self, room_id: str, timeout: float = 20.0, interval: float = 0.5) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                entry = self.get_room(room_id)
            except NekoRoomsError:
                return False
            if entry.get("is_ready"):
                return True
            time.sleep(interval)
        return False
