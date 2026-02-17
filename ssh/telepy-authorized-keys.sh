#!/bin/bash

# This script is called by sshd's AuthorizedKeysCommand to verify an offered
# SSH public key against the backend API.
#
# sshd invokes:  telepy-authorized-keys.sh %u %t %k
#   $1 = %u  username
#   $2 = %t  key type (e.g. ssh-rsa, ssh-ed25519)
#   $3 = %k  base64-encoded public key blob
#
# If the API finds the key in the database, it returns the key in
# "type base64_key" format on stdout — sshd then accepts it.
# An empty stdout means "not authorized."

LOG_FILE="/config/logs/auth_keys_debug.log"

KEY_USER="$1"
KEY_TYPE="$2"
KEY_BLOB="$3"

# --- Immediate entry log (always, even if everything else fails) ---
echo "[$(date)] AuthorizedKeysCommand invoked | argc=$# | user=$KEY_USER | type=$KEY_TYPE | key_prefix=${KEY_BLOB:0:20}..." >> "$LOG_FILE" 2>/dev/null || true

API_URL="http://backend:8000/api/reverse/internal/keys"

# Read the internal API token from the persisted file
# (sshd sanitizes env vars, so INTERNAL_API_TOKEN is not available directly)
TOKEN_FILE="/config/.internal_api_token"
INTERNAL_API_TOKEN=""
if [ -r "$TOKEN_FILE" ]; then
    INTERNAL_API_TOKEN=$(cat "$TOKEN_FILE")
fi

# Fetch key verification from backend API (authenticated via shared token)
curl_output=$(curl -s -f --max-time 5 -G \
    -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
    --data-urlencode "key_type=${KEY_TYPE}" \
    --data-urlencode "key=${KEY_BLOB}" \
    "${API_URL}" 2>>"$LOG_FILE")

exit_code=$?

# Log curl result
if [ $exit_code -eq 0 ]; then
    resp_len=${#curl_output}
    echo "[$(date)] curl OK | exit=$exit_code | response_len=$resp_len | non_empty=$([ -n "$curl_output" ] && echo yes || echo no)" >> "$LOG_FILE" 2>/dev/null || true
else
    echo "[$(date)] curl FAILED | exit=$exit_code" >> "$LOG_FILE" 2>/dev/null || true
fi

# Output to sshd: the key line (if any) or nothing
if [ $exit_code -eq 0 ] && [ -n "$curl_output" ]; then
    echo "$curl_output"
fi

# Always exit 0 — sshd treats non-zero as an error
exit 0
