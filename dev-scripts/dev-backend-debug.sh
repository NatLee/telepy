#!/bin/bash

source "$(dirname "$0")/common.sh"

# Recreate the backend container (picks up a rebuilt image / changed .env) and follow its logs.
print_message "$BLUE" "Recreating the backend container..."
docker compose up -d --force-recreate backend
print_message "$GREEN" "Following backend logs (Ctrl+C to stop)..."
docker compose logs -f backend
