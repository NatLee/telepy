#!/bin/bash

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