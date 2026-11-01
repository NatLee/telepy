#!/bin/bash

command -v autossh >/dev/null 2>&1 || { echo 'autossh not found. Please install autossh (e.g. apt/yum) before running this script.'; exit 1; }

echo "[+] AutoSSH Script start"
${known_hosts_setup}${ws_client_setup}${keepalive_setup}
autossh \
-M 0 \
${keepalive_option}${host_key_options}${proxy_option}${key_option}\
-p ${reverse_server_ssh_port} \
-NR '*:0:localhost:${ssh_port}' \
telepy@${server_domain}