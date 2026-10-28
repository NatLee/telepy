#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Constant: container names for Telepy
PROJECT_NAME=${PROJECT_NAME:-main}  # same default as .env.example / docker-compose.yml
CONTAINER_WEB_NAME="telepy-web-${PROJECT_NAME}"

# Function to print colored messages
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# 後端在 /data 底下的路徑對應的主機資料夾（compose 把 ./telepy-data 掛在 /data）；變數沒設 = 預設值。
# Host folder for a backend path under /data (compose mounts ./telepy-data there); an unset variable = the default.
# $1 = variable name (GEOIP_DIR / OUI_DIR), $2 = its default inside the container.
data_host_dir() {
    local name=$1 path=${!1:-$2}
    case "$path" in
        /data|/data/*) echo "./telepy-data${path#/data}" ;;
        *)
            print_message "$RED" "$name=$path is not under /data (the folder compose mounts from ./telepy-data). Put the files there yourself, or unset $name." >&2
            return 1 ;;
    esac
}
