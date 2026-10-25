#!/bin/bash

echo "[+] SSH Tunnel Script start"
${known_hosts_setup}${ws_client_setup}
ssh ${key_option}\
-o "ServerAliveInterval 30" \
-o "ServerAliveCountMax 3" \
${host_key_options}${proxy_option}-p ${reverse_server_ssh_port} \
-NR '*:0:localhost:${ssh_port}' \
telepy@${server_domain}