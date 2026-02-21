#!/bin/bash

source "$(dirname "$0")/common.sh"

if [ -z "$1" ]; then
  print_message "$RED" "Error: App name is required."
  print_message "$YELLOW" "Usage: $0 <app_name>"
  exit 1
fi

APP_NAME="$1"

print_message "$BLUE" "Creating new Django app '${APP_NAME}' in ${CONTAINER_WEB_NAME}..."
docker exec -it ${CONTAINER_WEB_NAME} bash -c "cd /src/backend && python manage.py startapp ${APP_NAME}"

if [ ! -d "./src/backend/${APP_NAME}" ]; then
  print_message "$RED" "Error: Folder not created."
  exit 1
fi

print_message "$YELLOW" "Adjusting permissions for the new app folder..."

# Check if we're on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  # On macOS, we use the current user's UID and GID
  docker exec -it ${CONTAINER_WEB_NAME} bash -c "chown -R $(id -u):$(id -g) /app/src/backend/${APP_NAME}"
else
  # On Linux, we can use $USER
  docker exec -it ${CONTAINER_WEB_NAME} bash -c "chown -R $USER:$USER /app/src/backend/${APP_NAME}"
fi

# Ensure the current user has read and write permissions
chmod -R u+rw "./src/backend/${APP_NAME}"

print_message "$GREEN" "New Django app '${APP_NAME}' created successfully."