#!/bin/bash
# Telepy reverse tunnel "${host_friendly_name}": this machine -> ${server_domain}:${reverse_server_ssh_port}
set -e

command -v docker >/dev/null 2>&1 || { echo 'docker not found. Please install Docker first.'; exit 1; }

echo "[+] Telepy Docker tunnel start"

# Let the Telepy web terminal reach this machine: append the service key (keeps existing keys).
TELEPY_KEY='${telepy_public_key}'
if [ -n "$TELEPY_KEY" ]; then
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    grep -qxF "$TELEPY_KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$TELEPY_KEY" >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
fi

# Private key whose public key is registered in Telepy.
KEY_FILE=${key_path}
[ -f "$KEY_FILE" ] || { echo "Private key not found: $KEY_FILE"; exit 1; }
${known_hosts_setup}
# The container reaches this machine's sshd through host.docker.internal (Docker 20.10+ / Docker Desktop).
docker rm -f telepy-tunnel >/dev/null 2>&1 || true
docker run -d \
  --name telepy-tunnel \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -v "$KEY_FILE":/id_rsa:ro \
${known_hosts_mount}  -e SSH_REMOTE_USER=telepy \
  -e SSH_REMOTE_HOST=${server_domain} \
  -e SSH_REMOTE_PORT=${reverse_server_ssh_port} \
  -e SSH_MODE=-R \
  -e 'SSH_BIND_IP=*' \
  -e SSH_TUNNEL_PORT=0 \
  -e SSH_TARGET_HOST=host.docker.internal \
  -e SSH_TARGET_PORT=${ssh_port} \
  -e SSH_SERVER_ALIVE_INTERVAL=30 \
  -e SSH_SERVER_ALIVE_COUNT_MAX=3 \
  -e AUTOSSH_GATETIME=0 \
  jnovack/autossh:latest

echo "[+] Container started. Logs: docker logs -f telepy-tunnel"
