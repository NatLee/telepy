#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Starting backend debug process..."

# 檢查 supervisor 是否正在運行 Django
supervisor_status=$(docker exec ${CONTAINER_WEB_NAME} bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf status django")

if [[ $supervisor_status == *"RUNNING"* ]]; then
  print_message "$YELLOW" "Supervisor is running Django, stopping it..."
  docker exec ${CONTAINER_WEB_NAME} bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf stop django"
else
  print_message "$YELLOW" "Supervisor is not running Django, checking for manually started Django..."
  django_pid=$(docker exec ${CONTAINER_WEB_NAME} bash -c "ps aux | grep 'python manage.py runserver' | grep -v grep | awk '{print \$2}'")

  if [ -n "$django_pid" ]; then
    print_message "$YELLOW" "Found manually started Django (PID: $django_pid), stopping it..."
    docker exec ${CONTAINER_WEB_NAME} bash -c "kill $django_pid"
  else
    print_message "$YELLOW" "No running Django instance found."
  fi
fi

print_message "$BLUE" "Waiting for Django to stop completely..."
sleep 5

print_message "$GREEN" "Starting new Django instance..."
docker exec -it ${CONTAINER_WEB_NAME} bash -c "python manage.py runserver 0.0.0.0:8000"