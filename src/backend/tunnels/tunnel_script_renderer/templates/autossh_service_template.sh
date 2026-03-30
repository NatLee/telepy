#!/bin/bash

echo "[+] AutoSSH Service Installation start"

SUDO=''
if [ "$EUID" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO='sudo'
    else
        echo "Error: Please run this script as root or install sudo."
        exit 1
    fi
fi

command -v autossh >/dev/null 2>&1 || { echo 'autossh not found. Please install autossh (e.g. apt/yum) before running this script.'; exit 1; }

SERVICE_PATH="/etc/systemd/system/telepy-tunnel.service"

cat << 'EOF' | $SUDO tee "$SERVICE_PATH" > /dev/null
[Unit]
Description=AutoSSH tunnel service for reverse SSH tunnel
After=network.target
Wants=network-online.target
After=network-online.target

[Service]
User=${username}

LogsDirectory=/var/log/autossh
Environment="AUTOSSH_DEBUG=1"
Environment="AUTOSSH_LOGFILE=/var/log/autossh/autossh.log"
Environment="AUTOSSH_GATETIME=0"

ExecStart=/usr/bin/autossh -M 0 -vv -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -o "StrictHostKeyChecking=no" -o "UserKnownHostsFile=/dev/null" ${key_option}-p ${reverse_server_ssh_port} -NR '*:${reverse_port}:localhost:${ssh_port}' telepy@${server_domain}

# Restart service after it exits
Restart=always
# Time to sleep before restarting a service
RestartSec=30
# Timeout for starting the service
TimeoutStartSec=5min
# Timeout for stopping the service
TimeoutStopSec=30

# Use process kill mode
KillMode=process

# Limit the restart rate
StartLimitInterval=5min
StartLimitBurst=3

[Install]
WantedBy=multi-user.target
EOF

echo "[+] Service file created at $SERVICE_PATH"

$SUDO systemctl daemon-reload
$SUDO systemctl enable telepy-tunnel.service
$SUDO systemctl restart telepy-tunnel.service

echo "[+] AutoSSH Service enabled and started."
$SUDO systemctl status telepy-tunnel.service --no-pager