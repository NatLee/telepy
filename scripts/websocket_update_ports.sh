#!/bin/bash

cd /src

while true; do
  # Run the update_ports command with the current ports and capture its output
  COMMAND_OUTPUT=$(python manage.py update_ports)
  # Print the command output to stdout (optional, for debugging purposes)
  echo "$COMMAND_OUTPUT"
  # Wait for 5 seconds before the next run
  sleep 5
done
