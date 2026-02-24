import os
import time
import socket
import logging
import subprocess
import requests
import uuid
import threading
from typing import Dict, Any

logger = logging.getLogger(__name__)

# Keep track of active remote browser sessions
# session_id -> { "ssh_process": Popen, "proxy_port": int, "target_target": str, "selenium_session_id": str }
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}

def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        PORT = s.getsockname()[1]
    return PORT

def start_remote_browser(target_username: str, target_reverse_port: int, server_id: int):
    """
    Start a remote browser session.
    1. Start a local ssh -D to the target.
    2. Start a selenium session using the local proxy.
    Returns: { "session_id": ..., "vnc_url": ... }
    """
    proxy_port = get_free_port()
    # Execute SSH -D. We are inside the backend container. It needs to hit the ssh reverse tunnel gateway.
    # The gateway is `reverse` container, but we use the ssh domain or `telepy-ssh` in the compose network.
    # Wait, in other views, `execute_ssh_command` uses `username@reverse`. 
    # Let's check what hostname the reverse tunnel uses.
    
    ssh_host = "reverse"
    ssh_cmd = f"ssh -N -q -D 0.0.0.0:{proxy_port} -p {target_reverse_port} {target_username}@{ssh_host}"
    
    logger.info(f"Starting SSH proxy for target {server_id} on port {proxy_port}")
    ssh_process = subprocess.Popen(ssh_cmd, shell=True)
    
    # Wait for proxy to listen
    time.sleep(2)
    if ssh_process.poll() is not None:
        raise Exception(f"Failed to start SSH proxy for target {server_id}. Command exited.")

    # Now request Selenium session
    # Standalone is at http://selenium-standalone:4444/wd/hub
    backend_hostname = os.getenv("HOSTNAME", "backend") # the backend container's hostname
    
    capabilities = {
        "capabilities": {
            "alwaysMatch": {
                "browserName": "chrome",
                "goog:chromeOptions": {
                    "args": [
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--start-maximized",
                        f"--proxy-server=socks5://{backend_hostname}:{proxy_port}",
                        "--proxy-bypass-list=<-loopback>"
                    ]
                }
            }
        }
    }
    
    selenium_url = "http://selenium-standalone:4444/wd/hub/session"
    try:
        res = requests.post(selenium_url, json=capabilities, timeout=10)
        res.raise_for_status()
        data = res.json()
        selenium_session_id = data.get("value", {}).get("sessionId")
    except requests.exceptions.HTTPError as e:
        ssh_process.terminate()
        error_msg = str(e)
        if res is not None:
            try:
                error_data = res.json()
                # Selenium usually returns a 'value' object with a 'message'
                if isinstance(error_data, dict) and "value" in error_data and "message" in error_data["value"]:
                    err_message = error_data["value"]["message"]
                    if "Could not start a new session" in err_message or "No available nodes" in err_message:
                        raise Exception("The Proxy Browser has reached its maximum concurrent user limit. Please wait for someone to disconnect and try again.")
            except Exception:
                pass
        raise Exception(f"Failed to start Selenium session: {error_msg}")
    except Exception as e:
        ssh_process.terminate()
        raise Exception(f"Failed to start Selenium session: {str(e)}")
        
    session_id = str(uuid.uuid4())
    ACTIVE_SESSIONS[session_id] = {
        "ssh_process": ssh_process,
        "proxy_port": proxy_port,
        "server_id": server_id,
        "selenium_session_id": selenium_session_id,
        "last_seen": time.time()
    }
    
    # VNC URL via Traefik
    vnc_url = f"/novnc/?autoconnect=true&resize=scale"
    
    return {
        "session_id": session_id,
        "vnc_url": vnc_url,
        "selenium_session_id": selenium_session_id
    }

def ping_remote_browser(session_id: str):
    session = ACTIVE_SESSIONS.get(session_id)
    if session:
        session["last_seen"] = time.time()
        return True
    return False

def stop_remote_browser(session_id: str):
    session = ACTIVE_SESSIONS.get(session_id)
    if not session:
        return False
        
    ssh_process = session["ssh_process"]
    selenium_session_id = session["selenium_session_id"]
    
    # Stop selenium session
    try:
        requests.delete(f"http://selenium-standalone:4444/wd/hub/session/{selenium_session_id}", timeout=5)
    except Exception as e:
        logger.warning(f"Failed to delete selenium session {selenium_session_id}: {e}")
        
    # Stop ssh proxy
    try:
        ssh_process.terminate()
        ssh_process.wait(timeout=5)
    except Exception as e:
        logger.warning(f"Failed to terminate SSH process: {e}")
        ssh_process.kill()
        
    del ACTIVE_SESSIONS[session_id]
    return True

# Simple cleanup thread to check if SSH processes died or frontend stopped pinging
def cleanup_dead_sessions():
    while True:
        try:
            dead_sessions = []
            now = time.time()
            for sid, sess in list(ACTIVE_SESSIONS.items()):
                # Clean up if SSH process died naturally OR if it hasn't been pinged in 60 seconds
                if sess["ssh_process"].poll() is not None or (now - sess.get("last_seen", now)) > 60:
                    dead_sessions.append(sid)
            for sid in dead_sessions:
                stop_remote_browser(sid)
        except Exception:
            pass
        time.sleep(10)

threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
