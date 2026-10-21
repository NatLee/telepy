#!/bin/bash

source "$(dirname "$0")/common.sh"

# Function to prompt for input with a default value
prompt_with_default() {
    local prompt="$1"
    local default="$2"
    local input

    read -p "$prompt [$default]: " input
    echo "${input:-$default}"
}

# Get user input
USERNAME=$(prompt_with_default "Enter username" "admin")
EMAIL=$(prompt_with_default "Enter email" "admin@admin.com")
PASSWORD=$(prompt_with_default "Enter password" "1234")

# Create superuser (the first user becomes a superuser automatically; this also works later)
print_message "$BLUE" "Creating superuser..."
docker exec -it ${CONTAINER_WEB_NAME} telepy-server create-superuser --username "$USERNAME" --email "$EMAIL" --password "$PASSWORD"

print_message "$GREEN" "Superuser created successfully."
