#!/bin/bash

echo "[+] Script start"

autossh \\
-M 6769 \\
-o "ServerAliveInterval 30" \\
-o "ServerAliveCountMax 3" \\
-o "StrictHostKeyChecking=no" \\
-o "UserKnownHostsFile=/dev/null" \\
-p ${reverse_server_ssh_port} \\
-NR '*:${reverse_port}:localhost:${ssh_port}' \\
telepy@${server_domain}