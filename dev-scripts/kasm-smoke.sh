#!/usr/bin/env bash
# kasm-browser 煙霧測試 —— 在「正式環境」執行(此容器需要 X/KasmVNC/Chromium,無法在
# 開發沙箱內跑)。驗證:session-manager 起得來、能開一個 VNC session、RFB 埠聽得到、backend
# 連得到、以及(可選)出口 IP == 目標機器。
#
# 用法:
#   docker compose up -d --build kasm-browser backend
#   ./dev-scripts/kasm-smoke.sh
set -euo pipefail

PROJECT="${PROJECT_NAME:-main}"
KASM="telepy-kasm-browser-${PROJECT}"
BACKEND="telepy-web-${PROJECT}"
TOKEN="$(grep -E '^INTERNAL_API_TOKEN=' .env | cut -d= -f2- || true)"

echo "== 1) session-manager healthz =="
docker compose exec -T backend python - <<PY
import os, requests
r = requests.get("http://kasm-browser:7000/healthz", timeout=5)
print("healthz:", r.status_code, r.text)
assert r.status_code == 200
PY

echo "== 2) KasmVNC / Chromium present in image (KasmVNC binary is Xkasmvnc) =="
docker exec "$KASM" sh -c 'command -v Xkasmvnc; command -v Xvnc; command -v chromium; command -v openbox' || true

echo "== 3) start a session via session-manager (proxy points at a dummy; browser will just fail to load pages, but Xvnc/RFB must come up) =="
docker compose exec -T backend python - <<PY
import requests, socket, os, time
tok = os.getenv("INTERNAL_API_TOKEN", "")
r = requests.post("http://kasm-browser:7000/sessions",
                  json={"proxy": "socks5://backend:1", "geometry": "1280x720"},
                  headers={"X-Internal-Token": tok}, timeout=40)
print("create:", r.status_code, r.text)
r.raise_for_status()
port = r.json()["rfb_port"]; sid = r.json()["session_id"]
# backend 連得到該 RFB 埠?
s = socket.create_connection(("kasm-browser", port), timeout=5)
greeting = s.recv(16); s.close()
print("RFB greeting:", greeting)
assert greeting.startswith(b"RFB "), "expected an RFB ProtocolVersion greeting"
requests.delete(f"http://kasm-browser:7000/sessions/{sid}",
                headers={"X-Internal-Token": tok}, timeout=10)
print("OK: session up, RFB reachable, greeting seen, stopped")
PY

echo
echo "全部通過。接著到 UI 按 Start Browser,應看到真桌面的 Chromium;"
echo "在其中開 IP 查詢頁,公網 IP 應等於目標機器(經 ssh -D 出口)。"
