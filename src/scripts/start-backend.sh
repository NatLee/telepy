#!/bin/bash
# 依 DEBUG 切換後端 ASGI 伺服器。/ Switch the backend ASGI server based on DEBUG.
#
# - dev（DEBUG=true）：runserver —— 保留 autoreload 與 ipdb/pdb 中斷點的除錯體驗。
#   注意：autoreload 會在原始碼存檔時重啟程序並斷開所有 WebSocket，此為 dev 慣例取捨。
# - prod（其他）：daphne —— 穩定、不 autoreload、不會因存檔而斷線；
#   靜態檔由 settings.MIDDLEWARE 內的 WhiteNoise 提供，無需 runserver 的自動靜態服務。
#
# dev (DEBUG=true): runserver, keeping autoreload + ipdb/pdb breakpoints (autoreload restarts on
#   source save and drops all WebSockets — an accepted dev-only trade-off).
# prod (otherwise): daphne — stable, reload-free; static is served by WhiteNoise middleware.
set -e
cd /src

DEBUG_LOWER=$(printf '%s' "${DEBUG:-false}" | tr '[:upper:]' '[:lower:]')

if [ "$DEBUG_LOWER" = "true" ]; then
  echo "[start-backend] DEBUG=true -> runserver (dev: autoreload + debugging)"
  exec python manage.py runserver 0.0.0.0:8000
else
  echo "[start-backend] DEBUG=${DEBUG:-false} -> daphne (prod: stable ASGI)"
  exec daphne -b 0.0.0.0 -p 8000 backend.asgi:application
fi
