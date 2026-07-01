from typing import List, Dict, Optional
import re
import subprocess
import base64

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

# sshd 在 SSH 容器內的監聽埠（見 ssh/sshd_config/sshd_config 的 `Port 2222`）。
# 裝置主動連進來的那條 control 連線，其「本地埠」就是這個值——我們用它把裝置的 client 連線
# 從 sshd 的其他 socket（loopback 轉發通道、被 backend 連入的 reverse_port 等）中精準辨識出來。
# The sshd listen port inside the SSH container (see `Port 2222` in ssh/sshd_config/sshd_config).
# A device's inbound control connection has THIS as its local port, which uniquely identifies it
# among the sshd child's other sockets (loopback forward channels, the reverse_port accept socket…).
SSHD_LISTEN_PORT = 2222


def _redis_get_raw(key: str) -> Optional[str]:
    """讀取 Redis 字串鍵的原始內容（保留換行）。逾時 / redis-cli 非零返回回傳 None。"""
    try:
        result = subprocess.run(
            f"redis-cli -h redis GET {key}",
            shell=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def _parse_listen_port_pids(ss_output: str) -> Dict[int, List[int]]:
    """
    從（已被 `echo $()` 扁平化的）`ss -tlnp` LISTEN blob 解析出 {listen_port: [pid, ...]}。
    `users:(("sshd",pid=N,fd=M))` 內無空白，扁平化後仍是完整 token，可穩定抓 pid。
    """
    port_pids: Dict[int, List[int]] = {}
    for seg in ss_output.split(' LISTEN '):
        m = re.search(r'(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)', seg)
        if not m:
            continue
        port = int(m.group(1))
        pids = [int(p) for p in re.findall(r'pid=(\d+)', seg)]
        if pids:
            port_pids.setdefault(port, []).extend(pids)
    return port_pids


def _parse_estab_rtt_by_pid(ss_estab: str) -> Dict[int, float]:
    """
    解析 `ss -tinp state established` 輸出，回傳 {pid: rtt_ms}。
    只採計「本地埠 == SSHD_LISTEN_PORT」的連線——即裝置連進 sshd 的 control 連線，其 kernel 平滑化
    RTT 就是裝置↔伺服器的真實網路延遲。使用者在用隧道時 sshd 會另開 loopback 轉發通道（RTT≈0），
    以及被 backend 連入 reverse_port 的 accept socket，這些本地埠都不是 2222，自然被排除。

    ss 輸出格式（每條連線兩行）：
        0 0 <local>:<lport> <peer>:<pport> users:(("sshd",pid=N,fd=M))
             cubic ... rtt:<srtt>/<rttvar> ...   ← 以空白/Tab 起首的續行
    rtt 的單位「已是毫秒」（浮點），不需再除以 1000。
    """
    result: Dict[int, float] = {}
    cur_pids: List[int] = []
    cur_is_client_conn = False
    for raw in ss_estab.splitlines():
        if not raw:
            continue
        if raw[0].isspace():
            # 續行：rtt 歸屬於上一條 socket 行；僅在該行是裝置 control 連線時採計。
            if cur_pids and cur_is_client_conn:
                m = re.search(r'\brtt:(\d+(?:\.\d+)?)', raw)
                if m:
                    rtt = float(m.group(1))
                    for pid in cur_pids:
                        # 同一 pid 若有多筆，取較小者（更貼近真正的 control 連線）。
                        if pid not in result or rtt < result[pid]:
                            result[pid] = rtt
            continue
        # socket 行
        parts = raw.split()
        if len(parts) < 4 or parts[0] == 'Recv-Q':
            cur_pids = []
            cur_is_client_conn = False
            continue
        cur_pids = [int(p) for p in re.findall(r'pid=(\d+)', raw)]
        # 本地埠取 Local Address 欄（第 3 欄）冒號後的數字，相容 IPv6 的 [::]:2222。
        try:
            local_port = int(parts[2].rsplit(':', 1)[1])
        except (IndexError, ValueError):
            local_port = None
        cur_is_client_conn = (local_port == SSHD_LISTEN_PORT)
    return result


def get_ss_latency_from_redis() -> Optional[Dict[int, float]]:
    """
    回傳 {reverse_port: rtt_ms}：每條反向隧道的「裝置↔伺服器」網路延遲（毫秒，四捨五入到 0.1）。

    關聯方式：reverse_port --(持有 LISTEN 的 sshd pid)--> 該 pid 的裝置 control 連線 rtt。
    對不上（無 pid / 無 rtt / 未在 established 中）的 reverse_port 不列入結果，前端一律視為 null。

    讀取失敗（Redis 逾時 / 非零返回 / ss_output 為空）時回傳 None，沿用 get_ss_output_from_redis
    的「取樣不可用」語意，讓 update_ports 本輪跳過延遲更新，不覆寫既有值。
    """
    ss_output = _redis_get_raw("ss_output")
    ss_estab = _redis_get_raw("ss_estab")
    if not ss_output or not ss_output.strip() or ss_estab is None:
        return None

    port_pids = _parse_listen_port_pids(ss_output)
    pid_rtt = _parse_estab_rtt_by_pid(ss_estab)

    reverse_ports = set(
        ReverseServerAuthorizedKeys.objects.values_list("reverse_port", flat=True)
    )
    latency: Dict[int, float] = {}
    for port, pids in port_pids.items():
        if port not in reverse_ports:
            continue
        for pid in pids:
            if pid in pid_rtt:
                latency[port] = round(pid_rtt[pid], 1)
                break
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
    try:
        result = subprocess.run(
            "redis-cli -h redis GET ss_output",
            shell=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return parse_ss_ports_from_redis(result.stdout, filter=filter)
