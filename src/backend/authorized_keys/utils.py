from typing import List, Dict, Optional
import re
import subprocess
import base64

import redis as _redis_lib

# 讀取 SSH 容器寫入 Redis 的原始字串鍵（ss_output / ss_probe_latency）。
# 這些鍵由 ssh 容器以 `redis-cli -x SET` 直接寫入，未經 Django cache 的 key 前綴/版本包裝，
# 因此無法用 Django cache.get 讀取；改用 redis-py 直連（取代每輪 spawn redis-cli subprocess）。
# Read the raw string keys the SSH container writes with `redis-cli -x SET`; these bypass Django
# cache's key prefixing, so we use a direct redis-py client instead of spawning redis-cli each cycle.
_redis_client = None


def _get_redis_client():
    global _redis_client
    if _redis_client is None:
        _redis_client = _redis_lib.Redis(
            host="redis", port=6379,
            socket_timeout=5, socket_connect_timeout=5,
        )
    return _redis_client

def is_valid_ssh_public_key(key: str) -> bool:
    """
    Check if the provided string is a valid SSH public key format.

    Args:
    - key (str): The SSH public key as a string.

    Returns:
    - bool: True if the key is in a valid format, False otherwise.
    """

    # Common SSH key prefixes
    valid_prefixes = ["ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-ed25519"]

    try:
        # Split the key into its components
        parts = key.strip().split()

        # Check if the key format starts with a valid prefix and has at least two parts
        if len(parts) < 2 or parts[0] not in valid_prefixes:
            return False

        # Decode the key part to check if it's correctly base64 encoded
        key_body = parts[1]
        base64.b64decode(key_body)
        return True
    except Exception:
        return False

def ssh(command:str, hostname:str):
    """
    Executes an SSH command on a remote server using subprocess.

    Args:
    - command (str): The command to execute.
    - hostname (str): Hostname or IP address of the SSH server.

    Returns:
    - str: The output from the command execution.
    """
    ssh_command = f"ssh {hostname} {command}"
    result = subprocess.run(ssh_command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    if result.returncode != 0:
        raise Exception(f"SSH command execution failed: {result.stderr}")

    return result.stdout

from authorized_keys.models import ReverseServerAuthorizedKeys

def parse_ss_ports_from_redis(ss_output:str, filter:bool) -> Dict[int, bool]:
    used_ports = set()
    for line in ss_output.split(' LISTEN '):
        match = re.search(r'^0 128 (127\.0\.0\.1|0\.0\.0\.0):(\d+)', line)
        if match:
            used_ports.add(int(match.group(2)))

    ports = {}
    # If filter is False, return all ports
    if not filter:
        ports = {port: True for port in used_ports}

    # Ensure all reverse ports are in the ports
    reverse_ports = ReverseServerAuthorizedKeys.objects.all().values_list("reverse_port", flat=True)
    for port in reverse_ports:
        if port not in used_ports:
            ports[port] = False # not used
        else:
            ports[port] = True
    return ports


def _redis_get_raw(key: str) -> Optional[str]:
    """讀取 Redis 字串鍵的原始內容（保留換行）。連線/逾時錯誤回傳 None。"""
    try:
        val = _get_redis_client().get(key)
    except Exception:
        return None
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8", errors="replace")
    return val


def get_ss_latency_from_redis() -> Optional[Dict[int, float]]:
    """
    回傳 {reverse_port: rtt_ms}：每條反向隧道「telepy-ssh ↔ 目標裝置」的真實往返延遲（毫秒）。

    來源：ssh 容器的 probe_latency 服務——它週期性地「主動」量測：連上 sshd 綁在 127.0.0.1 的
    reverse_port（-R 轉發），計時直到收到目標裝置 sshd 回傳的第一個 banner byte，那段時間就是一個
    往返（channel-open 過去、banner 回來）≈ 真實網路 RTT。關鍵：資料是走「已建立的隧道」來回，
    即使裝置的 control TCP 在前面被 docker-proxy / L4 LB 終結（此時被動的 kernel RTT 會失真成 ~0ms），
    這個主動量測仍反映真實延遲。結果以 `ss_probe_latency`（每行 "port rtt_ms"）寫入 Redis。

    讀取失敗（Redis 連線/逾時、或 probe 服務尚未寫入）回傳 None（本輪視為取樣不可用，不覆寫既有值）。
    某個 port 量不到時該 port 缺席，前端一律視為 null（顯示「—」）。
    Active-probe based: reflects the real telepy-ssh<->device RTT even when a proxy terminates the
    device's control TCP, because it times a byte round-trip through the live tunnel.
    """
    raw = _redis_get_raw("ss_probe_latency")
    if raw is None:
        return None
    latency: Dict[int, float] = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            latency[int(parts[0])] = round(float(parts[1]), 1)
        except ValueError:
            continue
    return latency


def get_ss_output_from_redis(filter=True) -> Optional[Dict[int, bool]]:
    """
    讀取 SSH 容器寫入 Redis 的 ss LISTEN 輸出，解析成 {port: is_listening}。

    讀取失敗（redis-cli 逾時 / 非零返回）或 ss_output 為空時回傳 None，代表「本輪取樣不可用」。
    這很重要：舊碼在讀不到時會回傳「所有 port = False」的字典，導致 update_ports 把每一條隧道都
    誤判為離線並發出假的斷線通知、還覆寫掉正確的 ports_status。改回傳 None 讓呼叫端自行決定
    （update_ports 直接跳過本輪；埠位配置改以 DB 既有埠為準）。

    Returns None when the ss_output read fails or is empty, signalling 'sample unavailable' so callers
    don't mistake a transient Redis hiccup for every tunnel going offline.
    """
    raw = _redis_get_raw("ss_output")
    if raw is None or not raw.strip():
        return None
    return parse_ss_ports_from_redis(raw, filter=filter)
