#!/bin/bash

source "$(dirname "$0")/common.sh"

# The backend reconciles the schema on every start; this runs the same step on demand.
print_message "$BLUE" "Reconciling the database schema in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} telepy-server migrate
print_message "$GREEN" "Database schema is up to date."
