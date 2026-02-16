#!/bin/bash
set -euo pipefail

load_dotenv_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0

  # Parse only simple KEY=VALUE lines (no command substitution, no backticks).
  # Supports optional "export " prefix and quoted values.
  while IFS= read -r line || [[ -n "$line" ]]; do
    # trim leading/trailing whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"

    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue

    line="${line#export }"

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"

      # strip inline comment for unquoted values
      if [[ "$val" != \"*\" && "$val" != \'*\' ]]; then
        val="${val%%\#*}"
        val="${val%"${val##*[![:space:]]}"}"
      fi

      # strip surrounding quotes
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then
        val="${BASH_REMATCH[1]}"
      elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
      fi

      export "$key=$val"
    fi
  done < "$f"
}

# Try load .env if present (container environments are preferred, but this helps in manual runs).
load_dotenv_file "/config/.env"
load_dotenv_file "/config/.env.local"
load_dotenv_file "/.env"

SERVER_DOMAIN="${SERVER_DOMAIN:-<SERVER_DOMAIN>}"
REVERSE_SERVER_SSH_PORT_RAW="${REVERSE_SERVER_SSH_PORT:-}"
REVERSE_SERVER_SSH_PORT="${REVERSE_SERVER_SSH_PORT_RAW:-<REVERSE_SERVER_SSH_PORT>}"
PROJECT_NAME="${PROJECT_NAME:-}"
WEB_SERVER_PORT="${WEB_SERVER_PORT:-}"

SSH_PORT_HINT_1="ssh -N telepy@${SERVER_DOMAIN}"
SSH_PORT_HINT_2="ssh -N -p <SSH_PORT> telepy@${SERVER_DOMAIN}"
SSH_PORT_FLAG=""
if [[ -n "$REVERSE_SERVER_SSH_PORT_RAW" ]]; then
  SSH_PORT_FLAG="-p ${REVERSE_SERVER_SSH_PORT_RAW}"
  SSH_PORT_HINT_1="ssh -N ${SSH_PORT_FLAG} telepy@${SERVER_DOMAIN}"
  SSH_PORT_HINT_2=""
fi

cat <<EOF
=======================================================
  [SYSTEM] Reverse Tunnel / Jump Host Access
  ------------------------------------------
  Interactive shell execution is DISABLED.
  You may use this account for port forwarding only.

  >>> Server Info (from env) <<<
  SERVER_DOMAIN=${SERVER_DOMAIN}
  REVERSE_SERVER_SSH_PORT=${REVERSE_SERVER_SSH_PORT}
  PROJECT_NAME=${PROJECT_NAME}
  WEB_SERVER_PORT=${WEB_SERVER_PORT}

  >>> Usage Reference <<<

  [Option A] Reverse SSH Tunnel (Expose local service)
  Step 1) On the INTERNAL machine (can reach internet), create a reverse tunnel to this server:
  - Publish the internal SSH (local :22) as this server's localhost:<REMOTE_PORT>:
    $ ssh -N ${SSH_PORT_FLAG} -R <REMOTE_PORT>:localhost:22 telepy@${SERVER_DOMAIN}

  - Publish an internal web app (local :8080) as this server's localhost:<REMOTE_PORT>:
    $ ssh -N ${SSH_PORT_FLAG} -R <REMOTE_PORT>:localhost:8080 telepy@${SERVER_DOMAIN}
EOF

if [[ -n "${SSH_PORT_HINT_2}" ]]; then
  cat <<EOF
  (If your SSH server port is NOT known, connect with one of these formats:)
    $ ${SSH_PORT_HINT_1}
    $ ${SSH_PORT_HINT_2}
EOF
fi

cat <<EOF

  Step 2) From your laptop/desktop, connect THROUGH this server to the internal machine:
  (Because GatewayPorts is disabled, the reverse port is only reachable as "localhost:<REMOTE_PORT>" on THIS server.)

  A) One-off command (no ssh config):
    $ ssh -o ProxyCommand="ssh -W %h:%p ${SSH_PORT_FLAG} telepy@${SERVER_DOMAIN}" -p <REMOTE_PORT> <internal_user>@localhost

  B) Recommended: ~/.ssh/config (example)
    # ========================================
    # Reverse Server Configuration
    # ========================================
    Host telepy-ssh-server
        HostName ${SERVER_DOMAIN}
        Port  ${REVERSE_SERVER_SSH_PORT}
        Compression yes
        User telepy

    # ========================================
    # Endpoint Configuration (example)
    # ========================================
    Host internal-target
        HostName localhost
        Port <REMOTE_PORT>
        Compression yes
        User <internal_user>
        ProxyCommand ssh -W %h:%p telepy-ssh-server

    # Then:
    #   $ ssh internal-target

  [Option B] sshuttle (VPN-like Tunnel)
  If you've created the ssh config above, you can route traffic through the INTERNAL machine via the alias:
  $ sshuttle -v -r internal-target 0/0 -x ${SERVER_DOMAIN} --dns --to-ns <TO_NS>
=======================================================
EOF

# If user tried to execute a remote command, deny it.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo "" 1>&2
  echo "[DENIED] Remote command execution is disabled for this account." 1>&2
  exit 1
fi

# If user connected with a TTY (typical interactive `ssh telepy@host`), show the
# message then disconnect. If no TTY (typical `ssh -N ...`), keep the session
# open so port forwarding can stay alive.
if [[ -n "${SSH_TTY:-}" ]]; then
  exit 0
fi

exec tail -f /dev/null