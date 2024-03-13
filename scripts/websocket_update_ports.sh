#!/bin/bash

cd /src

while true; do
  # Retrieve the current ports from Redis
  PORTS=$(redis-cli -h telepy-redis GET ports_log)

  # Check if the PORTS variable is empty or null or null string
  if [[ -z "$PORTS" ]] || [[ "$PORTS" == "nil" ]] || [[ "$PORTS" == "null" ]]; then
      PORTS="[]"
  fi

  # Run the update_ports command with the current ports and capture its output
  COMMAND_OUTPUT=$(python manage.py update_ports $PORTS)

  # Print the command output to stdout (optional, for debugging purposes)
  echo "$COMMAND_OUTPUT"

  # Parse the new set of activated ports from the command output
  # This regex looks for the pattern 'Activated ports: [any_content_here]'
  NEW_PORTS=$(echo "$COMMAND_OUTPUT" | grep -oP 'Activated ports: \K.*')
  if [[ -z "$NEW_PORTS" ]]; then
      NEW_PORTS="[]"
  fi

  redis-cli -h telepy-redis SET ports_log "$NEW_PORTS"

  # Wait for 5 seconds before the next run
  sleep 5
done
