#!/bin/bash

echo "[+] SSH Tunnel Script start"

ssh ${key_option}\
-o "ServerAliveInterval 30" \
-o "ServerAliveCountMax 3" \
-o "StrictHostKeyChecking=no" \
-o "UserKnownHostsFile=/dev/null" \
-p ${reverse_server_ssh_port} \
-NR '*:${reverse_port}:localhost:${ssh_port}' \
telepy@${server_domain}