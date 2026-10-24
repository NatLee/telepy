#!/bin/bash

command -v autossh >/dev/null 2>&1 || { echo 'autossh not found. Please install autossh (e.g. apt/yum) before running this script.'; exit 1; }

echo "[+] AutoSSH Script start"
${known_hosts_setup}${ws_client_setup}
autossh \
-M 0 \
-o "ServerAliveInterval 30" \
-o "ServerAliveCountMax 3" \
${host_key_options}${proxy_option}${key_option}\
-p ${reverse_server_ssh_port} \
-NR '*:${reverse_port}:localhost:${ssh_port}' \
telepy@${server_domain}