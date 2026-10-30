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
${known_hosts_setup}${ws_client_setup}
# Named after the tunnel's install id (no user, server or tunnel name).
SERVICE_PATH="/etc/systemd/system/${install_base}.service"

cat << 'EOF' | $SUDO tee "$SERVICE_PATH" > /dev/null
[Unit]
Description=${install_description}
After=network.target
Wants=network-online.target
After=network-online.target

[Service]
User=${username}

LogsDirectory=${install_base}
Environment="AUTOSSH_DEBUG=1"
Environment="AUTOSSH_LOGFILE=/var/log/${install_base}/autossh.log"
Environment="AUTOSSH_GATETIME=0"

ExecStart=/usr/bin/autossh -M 0 -vv -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" ${host_key_options}${proxy_option}${key_option}-p ${reverse_server_ssh_port} -NR '*:0:localhost:${ssh_port}' telepy@${server_domain}

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

${unit_fixup}echo "[+] Service file created at $SERVICE_PATH"

$SUDO systemctl daemon-reload
$SUDO systemctl enable ${install_base}.service
$SUDO systemctl restart ${install_base}.service

echo "[+] AutoSSH Service enabled and started."
$SUDO systemctl status ${install_base}.service --no-pager