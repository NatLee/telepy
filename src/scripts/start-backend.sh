#!/bin/bash
# 依 DEBUG 切換後端 ASGI 伺服器。/ Switch the backend ASGI server based on DEBUG.
#
# - dev（DEBUG=true）：runserver —— 保留 autoreload 與 ipdb/pdb 中斷點；由 INSTALLED_APPS 的
#   daphne 提供 ASGI/WebSocket。單一 process 對 dev 足夠。
#   注意：autoreload 會在原始碼存檔時重啟程序並斷開所有 WebSocket，此為 dev 慣例取捨。
# - prod（其他）：gunicorn 管理多個 uvicorn worker —— 多 process = 真正併發的 HTTP 與 WebSocket
#   （單一 daphne/runserver 只有一個 event loop 且 Django 同步 view 擠在單一執行緒，會序列化）。
#   channels_redis 讓跨 worker 的 group_send/通知照常運作，故業務邏輯無需改動。
#   worker 數由 GUNICORN_WORKERS 控制（預設 3；因單機 SQLite 有寫鎖，勿一次開太多）。
#
# dev (DEBUG=true): runserver (autoreload + debugging; daphne in INSTALLED_APPS serves WS). One process.
# prod (otherwise): gunicorn + N uvicorn workers = real HTTP/WS concurrency across processes. The Redis
#   channel layer keeps cross-worker group_send working, so no app-logic changes are needed. Keep the
#   worker count modest (GUNICORN_WORKERS, default 3) because a single SQLite file serialises writes.
set -e
cd /src

DEBUG_LOWER=$(printf '%s' "${DEBUG:-false}" | tr '[:upper:]' '[:lower:]')

if [ "$DEBUG_LOWER" = "true" ]; then
  echo "[start-backend] DEBUG=true -> runserver (dev: autoreload + debugging)"
  exec python manage.py runserver 0.0.0.0:8000
else
  WORKERS="${GUNICORN_WORKERS:-3}"
  echo "[start-backend] DEBUG=${DEBUG:-false} -> gunicorn + uvicorn workers (${WORKERS}) (prod: concurrent ASGI)"
  exec gunicorn backend.asgi:application \
    --worker-class uvicorn_worker.UvicornWorker \
    --workers "$WORKERS" \
    --bind 0.0.0.0:8000 \
    --timeout 120 \
    --graceful-timeout 30
fi
