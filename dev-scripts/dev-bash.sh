#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Executing command in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} bash