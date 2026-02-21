#!/bin/bash

CONFIG_FILE="/config/sshd/sshd_config"

echo "--- Setting up SSHD configuration..."
# Set SSHD configuration options
sed -i 's/#*AllowTcpForwarding.*/AllowTcpForwarding yes/' "$CONFIG_FILE"
sed -i 's/#*GatewayPorts.*/GatewayPorts no/' "$CONFIG_FILE"
sed -i 's/#*X11Forwarding.*/X11Forwarding yes/' "$CONFIG_FILE"

# --- Ensure log directory and file are writable by the sshd user (telepy) ---
mkdir -p /config/logs
touch /config/logs/auth_keys_debug.log
chmod 777 /config/logs
chmod 666 /config/logs/auth_keys_debug.log
echo "--- Log directory /config/logs prepared for sshd user."

# --- Persist INTERNAL_API_TOKEN for AuthorizedKeysCommand ---
# sshd sanitizes the environment, so env vars are NOT available to the
# AuthorizedKeysCommand script.  Write the token to a file instead.
TOKEN_FILE="/config/.internal_api_token"
echo -n "${INTERNAL_API_TOKEN:-}" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
chown "${USER_NAME:-telepy}:users" "$TOKEN_FILE"
echo "--- INTERNAL_API_TOKEN persisted to $TOKEN_FILE"

# --- AuthorizedKeysCommand: fetch keys from Backend API ---
chmod +x /usr/local/bin/telepy-authorized-keys.sh

# Remove any existing directives to avoid duplicates on restart
sed -i '/^[[:space:]]*AuthorizedKeysCommand /d' "$CONFIG_FILE"
sed -i '/^[[:space:]]*AuthorizedKeysCommandUser /d' "$CONFIG_FILE"
# Disable file-based key lookup — API is the sole source of truth
sed -i 's|^[[:space:]]*AuthorizedKeysFile.*|AuthorizedKeysFile none|' "$CONFIG_FILE"
echo "--- Cleaned existing AuthorizedKeys directives."

# Ensure we don't accumulate duplicate Match User telepy blocks on restarts.
tmp="$(mktemp)"
awk '
  BEGIN { skipping=0 }
  $0 ~ /^Match User telepy$/ { skipping=1; next }
  skipping && $0 ~ /^Match / { skipping=0 }
  !skipping { print }
' "$CONFIG_FILE" > "$tmp" && cat "$tmp" > "$CONFIG_FILE" && rm -f "$tmp"

# Append global AuthorizedKeysCommand (before any Match block)
# %u = username, %t = key type, %k = base64-encoded public key blob
cat >> "$CONFIG_FILE" << SSHD_GLOBAL

AuthorizedKeysCommand /usr/local/bin/telepy-authorized-keys.sh %u %t %k
AuthorizedKeysCommandUser ${USER_NAME:-telepy}
SSHD_GLOBAL

# Add custom configuration for user 'telepy'
cat >> "$CONFIG_FILE" << EOF

Match User telepy
  SetEnv SERVER_DOMAIN=${SERVER_DOMAIN:-}
  SetEnv REVERSE_SERVER_SSH_PORT=${REVERSE_SERVER_SSH_PORT:-}
  SetEnv PROJECT_NAME=${PROJECT_NAME:-}
  SetEnv WEB_SERVER_PORT=${WEB_SERVER_PORT:-}
  PermitTunnel yes
  X11Forwarding no
  AllowAgentForwarding no
  PermitTTY no
EOF

# --- Dump final sshd_config for debugging ---
echo "--- Final sshd_config (AuthorizedKeys-related lines):"
grep -n -E '(AuthorizedKeysFile|AuthorizedKeysCommand)' "$CONFIG_FILE"
echo "--- SSHD configuration updated successfully."