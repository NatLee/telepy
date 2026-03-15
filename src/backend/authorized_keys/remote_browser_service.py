import os
import time
import socket
import logging
import subprocess
import requests
import uuid
import threading
from typing import Dict, Any

from site_settings.models import SiteSettings

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
                    "excludeSwitches": ["enable-automation", "enable-logging"],
                    "useAutomationExtension": False,
                    "args": [
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--start-maximized",
                        f"--proxy-server=socks5://{backend_hostname}:{proxy_port}",
                        "--proxy-bypass-list=<-loopback>",
                        # Anti-bot-detection
                        "--disable-blink-features=AutomationControlled",
                        "--disable-infobars",
                        "--lang=en-US,en",
                    ],
                    "prefs": {
                        "credentials_enable_service": False,
                        "profile.password_manager_enabled": False,
                        "profile.default_content_setting_values.notifications": 2,
                        "default_search_provider_data.template_url_data": {
                            "keyword": "google.com",
                            "short_name": "Google",
                            "url": "https://www.google.com/search?q={searchTerms}"
                        }
                    }
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
        if selenium_session_id:
            session_base = f"http://selenium-standalone:4444/wd/hub/session/{selenium_session_id}"
            # Comprehensive anti-bot stealth via CDP injection
            stealth_js = """
                // 1. Remove navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                // 2. Fake plugins array (normal Chrome has 5 default plugins)
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        const plugins = [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                        ];
                        plugins.length = 3;
                        return plugins;
                    }
                });

                // 3. Fake languages
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

                // 4. Fix chrome.runtime (Selenium leaves it empty)
                window.chrome = window.chrome || {};
                window.chrome.runtime = window.chrome.runtime || {
                    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
                    PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
                    PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
                    RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
                    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
                    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                    connect: function() { return { onDisconnect: { addListener: function() {} } }; },
                    sendMessage: function() {}
                };

                // 5. Fix permissions query (Selenium exposes 'denied' for notifications)
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters)
                );

                // 6. Realistic WebGL vendor & renderer
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Google Inc. (Intel)';
                    if (parameter === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)';
                    return getParameter.call(this, parameter);
                };
                const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Google Inc. (Intel)';
                    if (parameter === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)';
                    return getParameter2.call(this, parameter);
                };

                // 7. Spoof hardwareConcurrency & deviceMemory
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

                // 8. Prevent iframe contentWindow detection
                const originalAttachShadow = Element.prototype.attachShadow;
                Element.prototype.attachShadow = function() {
                    return originalAttachShadow.apply(this, [{ mode: 'open' }]);
                };
            """
            try:
                requests.post(
                    f"{session_base}/chromium/send_command_and_get_result",
                    json={
                        "cmd": "Page.addScriptToEvaluateOnNewDocument",
                        "params": { "source": stealth_js }
                    },
                    timeout=5
                )
            except Exception:
                logger.debug(f"CDP injection skipped for session {selenium_session_id}")
            # Navigate to Google as initial page
            try:
                requests.post(
                    f"{session_base}/url",
                    json={"url": "https://www.google.com/"},
                    timeout=10
                )
            except Exception:
                logger.warning(f"Failed to navigate to Google for session {selenium_session_id}")
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
    if not session:
        return False

    session["last_seen"] = time.time()

    # 發送 no-op WebDriver 指令，重置 Selenium 的 SE_NODE_SESSION_TIMEOUT idle timer。
    # VNC 的手動操作不算 WebDriver 指令，不發這個的話 300s 後 Selenium 會關掉 Chrome。
    selenium_session_id = session.get("selenium_session_id")
    if selenium_session_id:
        try:
            requests.get(
                f"http://selenium-standalone:4444/wd/hub/session/{selenium_session_id}",
                timeout=3
            )
        except Exception:
            logger.debug(f"Keep-alive ping to Selenium failed for session {session_id}")

    return True

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
            idle_timeout = SiteSettings.get_solo().remote_browser_session_idle_timeout
            dead_sessions = []
            now = time.time()
            for sid, sess in list(ACTIVE_SESSIONS.items()):
                # Clean up if SSH process died naturally OR if it hasn't been pinged within idle_timeout seconds
                if sess["ssh_process"].poll() is not None or (now - sess.get("last_seen", now)) > idle_timeout:
                    dead_sessions.append(sid)
            for sid in dead_sessions:
                stop_remote_browser(sid)
        except Exception:
            pass
        time.sleep(10)

threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
