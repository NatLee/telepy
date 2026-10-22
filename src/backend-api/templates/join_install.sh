#!/bin/sh
# Telepy: join this machine as a device with one command.
#
#   curl -fsSL ${server_url}/api/join/install.sh | sudo sh -s -- --token TOKEN
#
# What it does, in order:
#   1. creates an SSH key for the tunnel (~/.ssh/telepy_tunnel_ed25519) if there is none
#   2. registers this machine with Telepy using the one-time token
#   3. adds Telepy's service key to ~/.ssh/authorized_keys (append only, once)
#   4. pins the Telepy gateway's host keys (~/.ssh/telepy_known_hosts)
#   5. installs the reverse tunnel as a service (systemd or launchd; otherwise a background loop)
#   6. waits until Telepy has logged in through the tunnel once
#
# Options:
#   --token TOKEN     join token from Telepy (required; single use, expires after 30 minutes)
#   --user NAME       account Telepy logs in to (default: the user who ran sudo, else the current user)
#   --ssh-port PORT   port of this machine's SSH server (default: detected, else 22)
#   --name NAME       tunnel name (default: the name set in Telepy, else this machine's hostname)
#   --no-service      run the tunnel in a background loop instead of installing a service
#
# Without sudo the tunnel runs as a user service (systemd --user / LaunchAgent), which may stop when you
# log out. Every file this script writes is listed at the end, together with an uninstall script.
set -eu

TELEPY_URL='${server_url}'

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Join this machine to Telepy as a device.

  curl -fsSL <telepy>/api/join/install.sh | sudo sh -s -- --token TOKEN [options]

  --token TOKEN     join token from Telepy (required; single use)
  --user NAME       account Telepy logs in to (default: the user who ran sudo, else the current user)
  --ssh-port PORT   port of this machine's SSH server (default: detected, else 22)
  --name NAME       tunnel name (default: the name set in Telepy, else this machine's hostname)
  --no-service      run the tunnel in a background loop instead of installing a service
USAGE
}

# --- HTTP helper (sets HTTP_STATUS and HTTP_BODY) -------------------------------------------------
http() {
    if [ "$#" -ge 3 ]; then
        HTTP_OUT=$(curl -sS -X "$1" -H 'Content-Type: application/json' -H 'Accept: text/plain' --data "$3" -w '\n%{http_code}' "$2") \
            || die "cannot reach $TELEPY_URL"
    else
        HTTP_OUT=$(curl -sS -H 'Accept: text/plain' -w '\n%{http_code}' "$2") || die "cannot reach $TELEPY_URL"
    fi
    HTTP_STATUS=$(printf '%s\n' "$HTTP_OUT" | tail -n 1)
    HTTP_BODY=$(printf '%s\n' "$HTTP_OUT" | sed '$d')
}

value() { printf '%s\n' "$HTTP_BODY" | sed -n "s/^$1=//p" | head -n 1; }

write_uninstall() {
    {
        printf '#!/bin/sh\n# Stops and removes the Telepy tunnel %s (#%s) installed by the join script.\n' "$TUNNEL_NAME" "$TUNNEL_ID"
        printf '%s\n' "$1"
        printf 'rm -f %s %s\n' "$KNOWN_HOSTS" "$UNINSTALL"
        printf 'echo "Stopped the tunnel. The key %s and the Telepy line in %s were kept; delete them if you no longer need them."\n' "$KEY" "$AUTH_KEYS"
    } > "$UNINSTALL"
    chmod 700 "$UNINSTALL"
    [ "$IS_ROOT" -eq 1 ] && chown "$TARGET_USER:$TARGET_GROUP" "$UNINSTALL"
    return 0
}

start_background() {
    RUNNER="$SSH_DIR/$UNIT.sh"
    LOG_FILE="$SSH_DIR/$UNIT.log"
    {
        printf '#!/bin/sh\n# Telepy reverse tunnel %s: reconnects forever.\n' "$TUNNEL_NAME"
        printf 'while :; do\n    %s %s\n    sleep 10\ndone\n' "$SSH_BIN" "$SSH_ARGS"
    } > "$RUNNER"
    chmod 700 "$RUNNER"
    # 先停掉舊的迴圈和它的 ssh（重跑時）。/ Stop a previous loop and its ssh child (re-runs).
    PATTERN="R $REVERSE_PORT:localhost:"
    pkill -f "$RUNNER" 2>/dev/null || true
    pkill -f "$PATTERN" 2>/dev/null || true
    nohup "$RUNNER" > "$LOG_FILE" 2>&1 &
    FILES="$FILES $RUNNER $LOG_FILE"
    LOGS="tail -f $LOG_FILE"
    BOOT="pkill -f $RUNNER; pkill -f '$PATTERN'"
    if command -v crontab >/dev/null 2>&1; then
        if { crontab -l 2>/dev/null | grep -vF "$RUNNER"; printf '@reboot %s >%s 2>&1\n' "$RUNNER" "$LOG_FILE"; } | crontab - 2>/dev/null; then
            say "started in the background; a crontab @reboot entry starts it after a reboot"
            BOOT="$BOOT; crontab -l 2>/dev/null | grep -vF $RUNNER | crontab -"
        else
            warn "started in the background, but it will not come back after a reboot (crontab failed)"
        fi
    else
        warn "started in the background, but it will not come back after a reboot (no service manager found)"
    fi
    write_uninstall "$BOOT; rm -f $RUNNER $LOG_FILE"
}

install_systemd_system() {
    UNIT_FILE="/etc/systemd/system/$UNIT.service"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Telepy reverse tunnel ($TUNNEL_NAME)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=$TARGET_USER
ExecStart=$SSH_BIN $SSH_ARGS
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$UNIT.service" >/dev/null 2>&1 || die "systemctl enable $UNIT failed"
    systemctl restart "$UNIT.service" || die "systemctl restart $UNIT failed (journalctl -u $UNIT)"
    FILES="$FILES $UNIT_FILE"
    LOGS="journalctl -u $UNIT -f"
    say "installed the systemd service $UNIT"
    write_uninstall "systemctl disable --now $UNIT.service; rm -f $UNIT_FILE; systemctl daemon-reload"
}

install_systemd_user() {
    UNIT_DIR="$TARGET_HOME/.config/systemd/user"
    UNIT_FILE="$UNIT_DIR/$UNIT.service"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Telepy reverse tunnel ($TUNNEL_NAME)
StartLimitIntervalSec=0

[Service]
ExecStart=$SSH_BIN $SSH_ARGS
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT.service" >/dev/null 2>&1 || die "systemctl --user enable $UNIT failed"
    systemctl --user restart "$UNIT.service" || die "systemctl --user restart $UNIT failed (journalctl --user -u $UNIT)"
    FILES="$FILES $UNIT_FILE"
    LOGS="journalctl --user -u $UNIT -f"
    say "installed the user service $UNIT"
    if ! loginctl show-user "$CURRENT_USER" -p Linger 2>/dev/null | grep -q '=yes' && ! loginctl enable-linger "$CURRENT_USER" >/dev/null 2>&1; then
        warn "the tunnel stops when $CURRENT_USER logs out. To keep it running, run: sudo loginctl enable-linger $CURRENT_USER (or re-run this script with sudo)"
    fi
    write_uninstall "systemctl --user disable --now $UNIT.service; rm -f $UNIT_FILE; systemctl --user daemon-reload"
}

install_launchd() {
    LABEL="com.telepy.tunnel.$TUNNEL_ID"
    if [ "$IS_ROOT" -eq 1 ]; then
        PLIST="/Library/LaunchDaemons/$LABEL.plist"
        DOMAIN=system
        USER_KEY="    <key>UserName</key><string>$TARGET_USER</string>"
    else
        mkdir -p "$TARGET_HOME/Library/LaunchAgents"
        PLIST="$TARGET_HOME/Library/LaunchAgents/$LABEL.plist"
        DOMAIN="gui/$(id -u)"
        USER_KEY=""
    fi
    mkdir -p "$TARGET_HOME/Library/Logs"
    LOG_FILE="$TARGET_HOME/Library/Logs/$UNIT.log"
    {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n'
        printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0">\n<dict>\n    <key>Label</key><string>%s</string>\n' "$LABEL"
        [ -n "$USER_KEY" ] && printf '%s\n' "$USER_KEY"
        printf '    <key>ProgramArguments</key>\n    <array>\n'
        for arg in $SSH_BIN $SSH_ARGS; do printf '        <string>%s</string>\n' "$arg"; done
        printf '    </array>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><true/>\n    <key>ThrottleInterval</key><integer>10</integer>\n'
        printf '    <key>StandardErrorPath</key><string>%s</string>\n</dict>\n</plist>\n' "$LOG_FILE"
    } > "$PLIST"
    if [ "$IS_ROOT" -eq 1 ]; then chown "$TARGET_USER:$TARGET_GROUP" "$LOG_FILE" 2>/dev/null || true; fi
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
        if [ "$IS_ROOT" -eq 0 ] && launchctl bootstrap "user/$(id -u)" "$PLIST" >/dev/null 2>&1; then
            DOMAIN="user/$(id -u)"
        else
            launchctl load -w "$PLIST" >/dev/null 2>&1 || die "launchctl could not load $PLIST"
        fi
    fi
    FILES="$FILES $PLIST $LOG_FILE"
    LOGS="tail -f $LOG_FILE"
    say "installed the launchd job $LABEL"
    [ "$IS_ROOT" -eq 0 ] && warn "as a LaunchAgent the tunnel runs while $CURRENT_USER is logged in; re-run with sudo to keep it running all the time"
    write_uninstall "launchctl bootout $DOMAIN/$LABEL 2>/dev/null || launchctl unload -w $PLIST 2>/dev/null; rm -f $PLIST $LOG_FILE"
}

main() {
    TOKEN=""
    TARGET_USER=""
    SSH_PORT=""
    NAME=""
    NO_SERVICE=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --token|--user|--ssh-port|--name)
                [ "$#" -ge 2 ] || die "$1 needs a value"
                case "$1" in
                    --token) TOKEN=$2 ;;
                    --user) TARGET_USER=$2 ;;
                    --ssh-port) SSH_PORT=$2 ;;
                    --name) NAME=$2 ;;
                esac
                shift 2 ;;
            --token=*) TOKEN=${1#*=}; shift ;;
            --user=*) TARGET_USER=${1#*=}; shift ;;
            --ssh-port=*) SSH_PORT=${1#*=}; shift ;;
            --name=*) NAME=${1#*=}; shift ;;
            --no-service) NO_SERVICE=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
    done

    case "$TOKEN" in
        "") die "missing --token (copy the whole command from Telepy)" ;;
        *[!A-Za-z0-9_-]*) die "the token looks wrong; copy the whole command from Telepy again" ;;
    esac
    case "$NAME" in
        *[!A-Za-z0-9._-]*) die "--name may only use letters, digits, '.', '_' and '-'" ;;
    esac
    case "$SSH_PORT" in
        "") ;;
        *[!0-9]*) die "--ssh-port must be a number" ;;
    esac

    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v ssh >/dev/null 2>&1 || die "the OpenSSH client (ssh) is required"
    command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is required"
    SSH_BIN=$(command -v ssh)

    OS=$(uname -s)
    CURRENT_USER=$(id -un)
    IS_ROOT=0
    [ "$(id -u)" -eq 0 ] && IS_ROOT=1

    # --- the account Telepy will log in to ---------------------------------------------------------
    if [ -z "$TARGET_USER" ]; then
        if [ "$IS_ROOT" -eq 1 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != root ]; then
            TARGET_USER=$SUDO_USER
        else
            TARGET_USER=$CURRENT_USER
        fi
    fi
    case "$TARGET_USER" in
        ""|-*|*[!A-Za-z0-9._-]*) die "invalid user name: $TARGET_USER" ;;
    esac
    if [ "$IS_ROOT" -eq 0 ] && [ "$TARGET_USER" != "$CURRENT_USER" ]; then
        die "run with sudo to set up another account ($TARGET_USER)"
    fi
    id "$TARGET_USER" >/dev/null 2>&1 || die "no such user: $TARGET_USER"
    TARGET_HOME=$(eval "printf '%s' ~$TARGET_USER")
    [ -d "$TARGET_HOME" ] || die "the home directory of $TARGET_USER was not found"
    case "$TARGET_HOME" in
        *[!A-Za-z0-9._/-]*) die "unsupported home directory path: $TARGET_HOME" ;;
    esac
    TARGET_GROUP=$(id -gn "$TARGET_USER")

    # --- this machine's SSH server ------------------------------------------------------------------
    if [ -z "$SSH_PORT" ]; then
        SSH_PORT=$( { sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || true; } | awk '$1 == "port" { print $2; exit }')
        [ -n "$SSH_PORT" ] || SSH_PORT=22
    fi
    step "Checking the SSH server on port $SSH_PORT"
    if command -v ssh-keyscan >/dev/null 2>&1; then
        if [ -z "$(ssh-keyscan -T 5 -p "$SSH_PORT" 127.0.0.1 2>/dev/null)" ]; then
            if [ "$OS" = Darwin ]; then
                die "no SSH server answers on port $SSH_PORT. Turn on Remote Login (System Settings > General > Sharing), or pass --ssh-port."
            fi
            die "no SSH server answers on port $SSH_PORT. Install and start openssh-server (e.g. sudo apt install openssh-server), or pass --ssh-port."
        fi
    fi
    say "ok"

    HOST_NAME=$( (hostname 2>/dev/null || uname -n) | tr -cd 'A-Za-z0-9._-')
    OS_INFO=$(uname -sm | tr -cd 'A-Za-z0-9._ -')

    # --- tunnel key ---------------------------------------------------------------------------------
    SSH_DIR="$TARGET_HOME/.ssh"
    KEY="$SSH_DIR/telepy_tunnel_ed25519"
    step "Preparing the tunnel key"
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    if [ ! -f "$KEY" ]; then
        ssh-keygen -q -t ed25519 -N '' -C "telepy-tunnel@$HOST_NAME" -f "$KEY" </dev/null 2>/dev/null \
            || ssh-keygen -q -t rsa -b 3072 -N '' -C "telepy-tunnel@$HOST_NAME" -f "$KEY" </dev/null \
            || die "could not create $KEY"
        say "created $KEY"
    else
        say "using $KEY"
    fi
    [ -f "$KEY.pub" ] || ssh-keygen -y -f "$KEY" > "$KEY.pub"
    PUBLIC_KEY=$(tr -d '"\\\r\n' < "$KEY.pub")


    # --- register -----------------------------------------------------------------------------------
    step "Registering this machine with Telepy"
    BODY=$(printf '{"public_key":"%s","hostname":"%s","username":"%s","ssh_port":%s,"os":"%s","name":"%s"}' \
        "$PUBLIC_KEY" "$HOST_NAME" "$TARGET_USER" "$SSH_PORT" "$OS_INFO" "$NAME")
    http POST "$TELEPY_URL/api/join/$TOKEN" "$BODY"
    case "$HTTP_STATUS" in
        2*) ;;
        *) die "$(value ERROR || true) (HTTP $HTTP_STATUS)" ;;
    esac
    TUNNEL_ID=$(value TUNNEL_ID)
    TUNNEL_NAME=$(value TUNNEL_NAME)
    REVERSE_PORT=$(value REVERSE_PORT)
    GATEWAY_HOST=$(value GATEWAY_HOST)
    GATEWAY_PORT=$(value GATEWAY_PORT)
    GATEWAY_USER=$(value GATEWAY_USER)
    SERVICE_KEY=$(value SERVICE_KEY)
    WEB_URL=$(value WEB_URL)
    HOST_KEYS=$(printf '%s\n' "$HTTP_BODY" | sed -n 's/^HOST_KEY=//p')
    case "$TUNNEL_ID$REVERSE_PORT$GATEWAY_PORT" in ""|*[!0-9]*) die "unexpected answer from Telepy" ;; esac
    case "$GATEWAY_HOST$GATEWAY_USER$TUNNEL_NAME" in ""|*[!A-Za-z0-9._-]*) die "unexpected answer from Telepy" ;; esac
    case "$SERVICE_KEY" in ssh-*|ecdsa-*) ;; *) die "Telepy sent no service key" ;; esac
    say "registered as $TUNNEL_NAME (tunnel #$TUNNEL_ID)"

    # --- authorize Telepy ---------------------------------------------------------------------------
    step "Authorizing Telepy to log in as $TARGET_USER"
    AUTH_KEYS="$SSH_DIR/authorized_keys"
    touch "$AUTH_KEYS"
    chmod 600 "$AUTH_KEYS"
    if grep -qxF "$SERVICE_KEY" "$AUTH_KEYS"; then
        say "the service key is already in $AUTH_KEYS"
    else
        if [ -s "$AUTH_KEYS" ] && [ -n "$(tail -c 1 "$AUTH_KEYS")" ]; then printf '\n' >> "$AUTH_KEYS"; fi
        printf '%s\n' "$SERVICE_KEY" >> "$AUTH_KEYS"
        say "added the service key to $AUTH_KEYS"
    fi

    # --- gateway host keys --------------------------------------------------------------------------
    KNOWN_HOSTS="$SSH_DIR/telepy_known_hosts"
    ALIAS="telepy-$GATEWAY_HOST-$GATEWAY_PORT"
    if [ -n "$HOST_KEYS" ]; then
        printf '%s\n' "$HOST_KEYS" | while IFS= read -r hk; do
            [ -n "$hk" ] && printf '%s %s\n' "$ALIAS" "$hk"
        done > "$KNOWN_HOSTS"
        STRICT=yes
    elif "$SSH_BIN" -G -o StrictHostKeyChecking=accept-new localhost >/dev/null 2>&1; then
        : > "$KNOWN_HOSTS"
        STRICT=accept-new
    else
        : > "$KNOWN_HOSTS"
        STRICT=no
    fi

    if [ "$IS_ROOT" -eq 1 ]; then
        chown "$TARGET_USER:$TARGET_GROUP" "$SSH_DIR" "$KEY" "$KEY.pub" "$AUTH_KEYS" "$KNOWN_HOSTS"
    fi

    SSH_ARGS="-NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=$STRICT -o UserKnownHostsFile=$KNOWN_HOSTS -o HostKeyAlias=$ALIAS -i $KEY -p $GATEWAY_PORT -R $REVERSE_PORT:localhost:$SSH_PORT $GATEWAY_USER@$GATEWAY_HOST"

    # --- run the tunnel -----------------------------------------------------------------------------
    UNIT="telepy-tunnel-$TUNNEL_ID"
    UNINSTALL="$SSH_DIR/telepy-uninstall-$TUNNEL_ID.sh"
    FILES="$KEY $KEY.pub $KNOWN_HOSTS $UNINSTALL"
    LOGS=""

    step "Starting the tunnel"
    if [ "$NO_SERVICE" -eq 1 ]; then
        start_background
    elif [ "$OS" = Linux ] && [ "$IS_ROOT" -eq 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        install_systemd_system
    elif [ "$OS" = Linux ] && [ "$IS_ROOT" -eq 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        install_systemd_user
    elif [ "$OS" = Darwin ] && command -v launchctl >/dev/null 2>&1; then
        install_launchd
    else
        start_background
    fi

    # --- self-test ----------------------------------------------------------------------------------
    step "Waiting for Telepy to log in through the tunnel"
    PHASE=""
    DETAIL=""
    i=0
    while [ "$i" -lt 45 ]; do
        http GET "$TELEPY_URL/api/join/$TOKEN/status"
        PHASE=$(value PHASE)
        DETAIL=$(value DETAIL)
        case "$PHASE" in
            verified|failed) break ;;
        esac
        sleep 2
        i=$((i + 1))
    done

    say ""
    say "Files: $FILES"
    say "Uninstall: sh $UNINSTALL"
    [ -n "$LOGS" ] && say "Logs: $LOGS"
    case "$PHASE" in
        verified)
            say ""
            say "Done. $TUNNEL_NAME is online and Telepy can log in as $TARGET_USER."
            say "Open it in Telepy: $WEB_URL"
            ;;
        failed)
            say ""
            die "$DETAIL"
            ;;
        registered)
            say ""
            die "the tunnel did not come up within 90 seconds. Check the logs above; outbound TCP to $GATEWAY_HOST:$GATEWAY_PORT must be allowed."
            ;;
        *)
            say ""
            die "Telepy has not confirmed the login yet (${DETAIL:-$PHASE}). Check the device in Telepy: $WEB_URL"
            ;;
    esac
}

main "$@"
