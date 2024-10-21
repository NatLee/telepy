#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Running database migrations in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} bash -c 'python manage.py makemigrations && python manage.py migrate'
print_message "$GREEN" "Database migrations completed."