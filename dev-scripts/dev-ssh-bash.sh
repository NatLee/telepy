#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Starting SSH shell in ${CONTAINER_SSH_NAME}..."
docker exec -it ${CONTAINER_SSH_NAME} bash