#!/bin/bash

# 載入環境變數
export $(grep -v '^#' .env | xargs)

# 檢查 supervisor 是否正在運行 Django
supervisor_status=$(docker exec telepy-web-${PROJECT_NAME} bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf status django")

if [[ $supervisor_status == *"RUNNING"* ]]; then
echo "Supervisor 正在運行 Django，使用 supervisor 停止..."
docker exec telepy-web-${PROJECT_NAME} bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf stop django"
else
echo "Supervisor 未運行 Django，嘗試查找是否有手動啟動的 Django ..."
django_pid=$(docker exec telepy-web-${PROJECT_NAME} bash -c "ps aux | grep 'python manage.py runserver' | grep -v grep | awk '{print \$2}'")

if [ -n "$django_pid" ]; then
    echo "找到手動啟動的 Django (PID: $django_pid)，正在停止..."
    docker exec telepy-web-${PROJECT_NAME} bash -c "kill $django_pid"
else
    echo "未找到運行中的 Django 。"
fi
fi

# 等待幾秒鐘，確保舊的 Django 已經完全停止
sleep 5

echo "啟動新的 Django ..."
docker exec -it telepy-web-${PROJECT_NAME} bash -c "python manage.py runserver 0.0.0.0:8000"
