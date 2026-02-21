#!/bin/bash
echo "-------- Install iproute2 (ss) --------"
apk add --no-cache iproute2 || true
echo "-------- Install net-tools (netstat) --------"
apk add --no-cache net-tools || true
echo "-------- Install redis --------"
apk add --no-cache redis
echo "-------- Install curl --------"
apk add --no-cache curl