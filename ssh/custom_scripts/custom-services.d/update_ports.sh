#!/bin/bash

while true; do
  echo `ss -tlnp` | redis-cli -h redis -x SET ss_output > /dev/null
  sleep 3
done

