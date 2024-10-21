#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Starting Supervisor control shell in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} supervisorctl -c /etc/supervisor/conf.d/supervisord.conf