#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Starting IPython shell in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} bash -c 'python manage.py shell'