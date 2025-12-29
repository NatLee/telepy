#!/bin/bash

CONFIG_FILE="/config/sshd/sshd_config"

echo "--- Setting up SSHD configuration..."
# Set SSHD configuration options
sed -i 's/#*AllowTcpForwarding.*/AllowTcpForwarding yes/' "$CONFIG_FILE"
sed -i 's/#*GatewayPorts.*/GatewayPorts no/' "$CONFIG_FILE"
sed -i 's/#*X11Forwarding.*/X11Forwarding yes/' "$CONFIG_FILE"

# Ensure we don't accumulate duplicate blocks on restarts.
tmp="$(mktemp)"
awk '
  BEGIN { skipping=0 }
  $0 ~ /^Match User telepy$/ { skipping=1; next }
  skipping && $0 ~ /^Match / { skipping=0 }
  !skipping { print }
' "$CONFIG_FILE" > "$tmp" && cat "$tmp" > "$CONFIG_FILE" && rm -f "$tmp"

# Add custom configuration for user 'telepy'
cat >> "$CONFIG_FILE" << EOF

Match User telepy
  # sshd sessions often start with a sanitized environment; SetEnv ensures the
  # ForceCommand script can read these values.
  SetEnv SERVER_DOMAIN=${SERVER_DOMAIN:-}
  SetEnv REVERSE_SERVER_SSH_PORT=${REVERSE_SERVER_SSH_PORT:-}
  SetEnv PROJECT_NAME=${PROJECT_NAME:-}
  SetEnv WEB_SERVER_PORT=${WEB_SERVER_PORT:-}
  AllowTcpForwarding yes
  PermitTunnel yes
  X11Forwarding no
  AllowAgentForwarding no
  PermitTTY yes
  ForceCommand /usr/local/bin/telepy-msg
EOF

echo "--- SSHD configuration updated successfully."