#!/bin/bash

while true; do
  echo $(ss -tlnp 2>/dev/null || /bin/netstat -tlnp 2>/dev/null) | /usr/bin/redis-cli -h redis -x SET ss_output > /dev/null 2>&1
  sleep 3
done

