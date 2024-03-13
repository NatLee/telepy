#!/bin/bash

cd /src

while true; do
  # Run your command and discard its output
  python manage.py update_ports > /dev/null 2>&1
  # Wait for 5 seconds before the next run
  sleep 5
done
