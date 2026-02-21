#!/bin/bash

echo "[+] Docker AutoSSH Script start"

# Create authorized_keys file with Telepy public key
mkdir -p ~/.ssh
cat > ~/.ssh/authorized_keys << 'EOF'
${telepy_public_key}
EOF

# Run AutoSSH in Docker container
docker run -d \
  --name telepy-tunnel \
  --restart unless-stopped \
  -p ${reverse_port}:${reverse_port}${key_mount} \
  alpine/autossh:latest \
  autossh \
  -M 0 \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  -o "StrictHostKeyChecking=no" \
  -o "UserKnownHostsFile=/dev/null"${key_option} \
  -p ${reverse_server_ssh_port} \
  -NR '*:${reverse_port}:localhost:${ssh_port}' \
  telepy@${server_domain}

echo "[+] Docker container started. Check logs with: docker logs telepy-tunnel"
