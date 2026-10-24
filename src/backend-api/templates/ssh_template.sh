#!/bin/bash

echo "[+] SSH Tunnel Script start"
${known_hosts_setup}
ssh ${key_option}\
-o "ServerAliveInterval 30" \
-o "ServerAliveCountMax 3" \
${host_key_options}-p ${reverse_server_ssh_port} \
-NR '*:${reverse_port}:localhost:${ssh_port}' \
telepy@${server_domain}