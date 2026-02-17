#!/bin/bash
echo "-------- Install iproute2 --------"
apk add --no-cache iproute2
echo "-------- Install redis --------"
apk add --no-cache redis
echo "-------- Install curl --------"
apk add --no-cache curl