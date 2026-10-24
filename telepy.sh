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
        print_message "$YELLOW" "Starting backend container shell..."
        execute_script "dev-bash" "$@"
        ;;
    migration)
        shift
        execute_script "dev-migrations" "$@"
        ;;
    backend-debug)
        shift
        execute_script "dev-backend-debug" "$@"
        ;;
    geoip)
        shift
        execute_script "dev-geoip" "$@"
        ;;
    doctor)
        shift
        execute_script "dev-doctor" "$@"
        ;;
    *)
        print_message "$YELLOW" "Usage: $0 sub-command [args]"
        print_message "$BLUE" "Sub-commands:"
        print_message "$GREEN" "  keygen: Generate SSH host keys (gateway) and the backend service key."
        print_message "$GREEN" "  create-superuser: Create an admin account for Telepy management."
        print_message "$GREEN" "  shell: Open a shell in the backend container."
        print_message "$GREEN" "  migration: Reconcile the database schema (also runs automatically on start)."
        print_message "$GREEN" "  backend-debug: Recreate the backend container and follow its logs."
        print_message "$GREEN" "  geoip: Download the offline IP geolocation databases (DB-IP Lite; re-run monthly)."
        print_message "$GREEN" "  doctor: Check .env, containers, ports and the backend's configuration; exits 1 when something is broken."
        ;;
esac
