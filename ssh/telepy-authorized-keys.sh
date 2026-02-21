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
#
# NOTE: sshd runs this with a sanitized environment (minimal or empty PATH).
# We use absolute paths for curl and explicit PATH so the script works when
# invoked by sshd, not only when run manually.
#
# Debugging (inside SSH container):
#   0. Confirm sshd uses our config and directive:
#        grep -E "AuthorizedKeysCommand|AuthorizedKeysFile" /config/sshd/sshd_config
#      Expect: AuthorizedKeysFile none, AuthorizedKeysCommand /usr/local/bin/telepy-authorized-keys.sh ...
#   1. If auth fails, check whether sshd invokes us at all:
#        cat /tmp/telepy-authkeys-debug.log
#      No new lines after SSH attempt → AuthorizedKeysCommand not run (wrong config or not loaded).
#   2. "AuthorizedKeysCommand invoked" but "curl FAILED" → PATH/curl or network; check /config/logs/auth_keys_debug.log for curl stderr.
#   3. Manual test (same args sshd would pass):
#        /usr/local/bin/telepy-authorized-keys.sh telepy ssh-ed25519 <base64_key_blob>

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CURL_CMD="/usr/bin/curl"

LOG_FILE="/config/logs/auth_keys_debug.log"
FALLBACK_LOG="/tmp/telepy-authkeys-debug.log"

KEY_USER="$1"
KEY_TYPE="$2"
KEY_BLOB="$3"

# --- Immediate entry log: primary and fallback (to confirm sshd actually invokes us) ---
_entry_msg="[$(date '+%Y-%m-%d %H:%M:%S')] AuthorizedKeysCommand invoked | argc=$# | user=$KEY_USER | type=$KEY_TYPE | key_prefix=${KEY_BLOB:0:20}..."
echo "$_entry_msg" >> "$LOG_FILE" 2>/dev/null || true
echo "$_entry_msg" >> "$FALLBACK_LOG" 2>/dev/null || true

API_URL="http://backend:8000/api/reverse/internal/keys"

# Read the internal API token from the persisted file
# (sshd sanitizes env vars, so INTERNAL_API_TOKEN is not available directly)
TOKEN_FILE="/config/.internal_api_token"
INTERNAL_API_TOKEN=""
if [ -r "$TOKEN_FILE" ]; then
    INTERNAL_API_TOKEN=$(cat "$TOKEN_FILE")
fi
_token_len=${#INTERNAL_API_TOKEN}
echo "[$(date '+%Y-%m-%d %H:%M:%S')] token_read=$([ -n "$INTERNAL_API_TOKEN" ] && echo "yes" || echo "no") token_len=$_token_len curl=$CURL_CMD" >> "$FALLBACK_LOG" 2>/dev/null || true

# Prefer /usr/bin/curl; fallback to PATH if not present (e.g. some images use /usr/local/bin/curl)
if [ ! -x "$CURL_CMD" ]; then
    CURL_CMD="curl"
fi

# Fetch key verification from backend API (authenticated via shared token)
curl_output=$("$CURL_CMD" -s -f --max-time 5 -G \
    -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
    --data-urlencode "key_type=${KEY_TYPE}" \
    --data-urlencode "key=${KEY_BLOB}" \
    "${API_URL}" 2>>"$LOG_FILE")

exit_code=$?

# Log curl result (both logs for debugging when auth command doesn't call API)
if [ $exit_code -eq 0 ]; then
    resp_len=${#curl_output}
    _ok_msg="[$(date '+%Y-%m-%d %H:%M:%S')] curl OK | exit=$exit_code | response_len=$resp_len | non_empty=$([ -n "$curl_output" ] && echo yes || echo no)"
    echo "$_ok_msg" >> "$LOG_FILE" 2>/dev/null || true
    echo "$_ok_msg" >> "$FALLBACK_LOG" 2>/dev/null || true
else
    _fail_msg="[$(date '+%Y-%m-%d %H:%M:%S')] curl FAILED | exit=$exit_code"
    echo "$_fail_msg" >> "$LOG_FILE" 2>/dev/null || true
    echo "$_fail_msg" >> "$FALLBACK_LOG" 2>/dev/null || true
fi

# Output to sshd: the key line (if any) or nothing
if [ $exit_code -eq 0 ] && [ -n "$curl_output" ]; then
    echo "$curl_output"
fi

# Always exit 0 — sshd treats non-zero as an error
exit 0
