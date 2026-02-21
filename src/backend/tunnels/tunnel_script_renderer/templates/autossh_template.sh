#!/bin/bash

echo "[+] AutoSSH Script start"

autossh \
-M 0 \
-o "ServerAliveInterval 30" \
-o "ServerAliveCountMax 3" \
-o "StrictHostKeyChecking=no" \
-o "UserKnownHostsFile=/dev/null" ${key_option}\
-p ${reverse_server_ssh_port} \
-NR '*:${reverse_port}:localhost:${ssh_port}' \
telepy@${server_domain}