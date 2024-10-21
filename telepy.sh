#!/bin/bash

# Load environment variables
export $(grep -v '^#' .env | xargs)

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Constant: container names for Telepy
CONTAINER_WEB_NAME="telepy-web-${PROJECT_NAME}"
CONTAINER_SSH_NAME="telepy-ssh-${PROJECT_NAME}"

# Function to print colored messages
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# Function to execute scripts
execute_script() {
    local script=$1
    shift
    if [ -f "./dev-scripts/$script.sh" ]; then
        bash "./dev-scripts/$script.sh" "$@"
    else
        print_message "$RED" "Error: Script $script not found."
        exit 1
    fi
}

# Main script logic
case "$1" in
    keygen)
        shift
        execute_script "dev-keygen" "$@"
        ;;
    create-superuser)
        shift
        execute_script "dev-create-superuser" "$@"
        ;;
    shell)
        shift
        print_message "$YELLOW" "Starting Web Server container shell..."
        execute_script "dev-bash" "$@"
        ;;
    ipython)
        shift
        execute_script "dev-shell" "$@"
        ;;
    supervisorctl)
        shift
        execute_script "dev-supervisorctl" "$@"
        ;;
    ssh-shell)
        shift
        print_message "$YELLOW" "Starting SSH container shell..."
        execute_script "dev-ssh-bash" "$@"
        ;;
    migration)
        shift
        execute_script "dev-migrations" "$@"
        ;;
    backend-debug)
        shift
        execute_script "dev-backend-debug" "$@"
        ;;
    collect-static)
        shift
        execute_script "dev-collect-statics" "$@"
        ;;
    django-startapp)
        shift
        execute_script "dev-startapp" "$@"
        ;;
    *)
        print_message "$YELLOW" "Usage: $0 sub-command [args]"
        print_message "$BLUE" "Sub-commands:"
        print_message "$GREEN" "  keygen: Generate SSH keys for Telepy service."
        print_message "$GREEN" "  create-superuser: Create an admin account for Telepy management."
        print_message "$GREEN" "  shell: Create a shell to run arbitrary command."
        print_message "$GREEN" "  ipython: Create a shell to run ipython."
        print_message "$GREEN" "  supervisorctl: Attach to supervisor control shell."
        print_message "$GREEN" "  ssh-shell: Similar to 'shell', but for ssh container."
        print_message "$GREEN" "  migration: Run migration process."
        print_message "$GREEN" "  backend-debug: Recreate and attach to backend container."
        print_message "$GREEN" "  collect-static: Collect static files to increase rendering speed."
        print_message "$GREEN" "  django-startapp: Create a new Django app."
        ;;
esac