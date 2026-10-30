#!/bin/sh
# Telepy: join this machine as a device with one command.
#
#   curl -fsSL ${server_url}/api/join/install.sh | sudo sh -s -- --token TOKEN
#
# What it does, in order (every step prints what it found and why it chose what it chose):
#   1. looks at what this machine has: shell, HTTP tool, SSH client (OpenSSH or Dropbear's dbclient), the SSH
#      server that listens on the SSH port, the key tool, and the service manager (procd / systemd / launchd)
#   2. reads this machine's SSH host key and checks it with a strict handshake (never trusted just because a
#      file exists; never with host-key checking turned off)
#   3. checks that the Telepy gateway answers, pins its host key, and tests whether SSH keepalives work on this
#      build (some OpenWrt builds time out as soon as ServerAliveInterval is set) — all before the token is used
#   4. creates the tunnel key (~/.ssh/telepy_tunnel_ed25519, or a Dropbear-format key for dbclient) if none
#   5. registers this machine with Telepy using the one-time token
#   6. adds Telepy's service key where THIS SSH server reads keys (append only, once)
#   7. installs the reverse tunnel as a service: procd (OpenWrt), systemd, launchd, else a background loop
#   8. waits until Telepy has logged in through the tunnel once, and reports five separate states:
#      files installed / starts at boot / process running / tunnel connected / login verified
#
# Everything it installs is named after a random install id that Telepy records on the tunnel (telepy-<id>,
# com.telepy.tunnel.<id>, ~/.ssh/telepy-<id>.*): no user, server or tunnel name, and Telepy knows what to clean up.
# A small record of what was installed goes to ~/.ssh/telepy-<id>.install (no secrets), the uninstall script next to it.
#
# Options:
#   --token TOKEN            join token from Telepy (required unless --check; single use, expires after 30 minutes)
#   --check                  preflight only: detect, check the SSH server and the gateway, print a report; uses no token
#   --user NAME              account Telepy logs in to (default: the user who ran sudo, else the current user)
#   --ssh-port PORT          port of this machine's SSH server (default: detected, else 22)
#   --ssh-host ADDR          address the SSH server listens on (default: detected; 127.0.0.1 when it listens everywhere)
#   --authorized-keys PATH   where this SSH server reads this account's keys (default: resolved from the server)
#   --client openssh|dbclient  which SSH client runs the tunnel (default: OpenSSH when it is really OpenSSH, else dbclient)
#   --service procd|systemd|launchd|loop  how the tunnel is kept running (default: what the machine has)
#   --name NAME              tunnel name (default: the name set in Telepy, else this machine's hostname)
#   --compat-no-server-alive use TCP keepalive instead of SSH ServerAlive (see --check; applied automatically
#                            only when the probe shows ServerAlive times out during the key exchange)
#   --no-compat              never switch to the compat mode automatically
#   --no-service             same as --service loop
#   --via-web                carry the tunnel inside a WebSocket on Telepy's web port (networks that only let
#                            443 out); needs python3 on this machine
#   --ssh-dir DIR            where the tunnel key, known_hosts, record and uninstall script go (default: ~/.ssh)
#
# Without sudo the tunnel runs as a user service (systemd --user / LaunchAgent), which may stop when you log out.
# Runs on POSIX sh, BusyBox ash included (no bash, GNU tools, python or curl assumed; wget / uclient-fetch work).
set -eu

TELEPY_URL='${server_url}'

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'USAGE'
Join this machine to Telepy as a device.

  curl -fsSL <telepy>/api/join/install.sh | sudo sh -s -- --token TOKEN [options]
  curl -fsSL <telepy>/api/join/install.sh -o telepy-join.sh && sh telepy-join.sh --check

  --token TOKEN           join token from Telepy (required unless --check; single use)
  --check                 preflight only (no token used): what this machine has, SSH server, gateway, keepalive
  --user NAME             account Telepy logs in to (default: the user who ran sudo, else the current user)
  --ssh-port PORT         port of this machine's SSH server (default: detected, else 22)
  --ssh-host ADDR         address the SSH server listens on (default: detected)
  --authorized-keys PATH  where this SSH server reads this account's keys (default: resolved from the server)
  --client openssh|dbclient         SSH client for the tunnel (default: OpenSSH if real, else dbclient)
  --service procd|systemd|launchd|loop  how the tunnel is kept running (default: detected)
  --name NAME             tunnel name (default: the name set in Telepy, else this machine's hostname)
  --compat-no-server-alive          TCP keepalive instead of SSH ServerAlive (see --check)
  --no-compat             never switch to the compat mode automatically
  --no-service            same as --service loop
  --via-web               carry the tunnel inside a WebSocket on Telepy's web port (needs python3)
  --ssh-dir DIR           where the key, known_hosts, record and uninstall script go (default: ~/.ssh)
USAGE
}

# --- small helpers --------------------------------------------------------------------------------
# Run a command with a time limit. `timeout` exists on most Linux but not on stock OpenWrt or macOS, so the
# fallback is a watchdog; its own output is closed, else a $(...) around this would wait for the watchdog.
with_timeout() {
    wt_secs=$1; shift
    if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" "$wt_secs" "$@" && return 0 || return $?
    fi
    "$@" &
    wt_pid=$!
    ( sleep "$wt_secs"; kill "$wt_pid" 2>/dev/null ) >/dev/null 2>&1 &
    wt_watch=$!
    wt_rc=0
    wait "$wt_pid" || wt_rc=$?
    kill "$wt_watch" 2>/dev/null || true
    return "$wt_rc"
}

# The command that installs a component on THIS system (package names differ per manager). Only ever printed in a hint:
# this script installs nothing itself. Like tailscale's install.sh the manager comes from what is on the PATH, not from
# the distro name, so an unknown distro still gets a usable hint.
pkg_hint() {
    case "$PKG" in
        opkg) case "$1" in curl) p=curl ;; openssh) p="openssh-client openssh-keygen" ;; dropbear) p=dropbear ;; ca) p=ca-bundle ;; sshd) p="dropbear && /etc/init.d/dropbear start" ;; esac; printf 'opkg install %s' "$p" ;;
        apk) case "$1" in curl) p=curl ;; openssh) p="openssh-client openssh-keygen" ;; dropbear) p=dropbear ;; ca) p=ca-certificates ;; sshd) p="openssh-server && rc-service sshd start" ;; esac; printf 'apk add %s' "$p" ;;
        apt) case "$1" in curl) p=curl ;; openssh) p=openssh-client ;; dropbear) p=dropbear-bin ;; ca) p=ca-certificates ;; sshd) p=openssh-server ;; esac; printf 'sudo apt install %s' "$p" ;;
        dnf|yum) case "$1" in curl) p=curl ;; openssh) p=openssh-clients ;; dropbear) p=dropbear ;; ca) p=ca-certificates ;; sshd) p="openssh-server && sudo systemctl enable --now sshd" ;; esac; printf 'sudo %s install %s' "$PKG" "$p" ;;
        zypper) case "$1" in curl) p=curl ;; openssh) p=openssh-clients ;; dropbear) p=dropbear ;; ca) p=ca-certificates ;; sshd) p=openssh-server ;; esac; printf 'sudo zypper install %s' "$p" ;;
        pacman) case "$1" in curl) p=curl ;; openssh) p=openssh ;; dropbear) p=dropbear ;; ca) p=ca-certificates ;; sshd) p="openssh && sudo systemctl enable --now sshd" ;; esac; printf 'sudo pacman -S %s' "$p" ;;
        brew) case "$1" in curl) p=curl ;; openssh) p=openssh ;; dropbear) p=dropbear ;; ca) p=ca-certificates ;; sshd) p="(turn on Remote Login in System Settings)" ;; esac; printf 'brew install %s' "$p" ;;
        pkg) case "$1" in curl) p=curl ;; openssh) p=openssh-portable ;; dropbear) p=dropbear ;; ca) p=ca_root_nss ;; sshd) p="(enable sshd in /etc/rc.conf)" ;; esac; printf 'pkg install %s' "$p" ;;
        *) printf 'install %s with this system'"'"'s package manager' "$1" ;;
    esac
}

# JSON string value: only safe characters survive (nothing here needs quotes or backslashes).
jstr() { printf '%s' "$1" | tr -cd 'A-Za-z0-9 ._()/:+=@,-' | cut -c1-120; }

# The filesystem type under a path (/proc/mounts, longest mount point wins). Empty when unknown.
fs_type() {
    [ -r /proc/mounts ] || return 0
    ft_best=""; ft_type=""
    while read -r ft_dev ft_mnt ft_fs ft_rest; do
        case "$1" in
            "$ft_mnt"|"$ft_mnt"/*|"${ft_mnt%/}"/*)
                if [ "${#ft_mnt}" -ge "${#ft_best}" ]; then ft_best=$ft_mnt; ft_type=$ft_fs; fi ;;
        esac
    done < /proc/mounts
    printf '%s' "$ft_type"
}

# --- integrity of this very file (only when run from a file; `curl | sh` cannot re-read itself) ------------
# Telepy appends "# telepy-sha256: <hex>" over everything before it. A paste that lost characters, a CRLF
# conversion or a BOM is reported as a damaged file instead of a baffling ash syntax error.
self_check() {
    sc_file=$1
    [ -n "$sc_file" ] && [ -f "$sc_file" ] || { SELF_CHECK="not checked (piped)"; return 0; }
    if [ "$(head -c 3 "$sc_file" | tr -d '\357\273\277' | wc -c | tr -d ' ')" = 0 ]; then
        die "$sc_file starts with a UTF-8 byte-order mark; download it again (curl -o / wget -O), do not save it from an editor"
    fi
    if grep -q "$(printf '\r')" "$sc_file" 2>/dev/null; then
        die "$sc_file has Windows line endings (CRLF); download it again instead of copying it through an editor"
    fi
    sc_want=$(tail -n 1 "$sc_file" | sed -n 's/^# telepy-sha256: \([0-9a-f]*\)$/\1/p')
    if [ -z "$sc_want" ]; then
        SELF_CHECK="no checksum line (incomplete download or an older server)"
        warn "this file has no checksum line at the end: the download may be incomplete"
        return 0
    fi
    if have sha256sum; then sc_got=$(sed '$d' "$sc_file" | sha256sum | cut -d' ' -f1)
    elif have shasum; then sc_got=$(sed '$d' "$sc_file" | shasum -a 256 | cut -d' ' -f1)
    elif have openssl; then sc_got=$(sed '$d' "$sc_file" | openssl dgst -sha256 | sed 's/^.*= *//')
    else SELF_CHECK="no sha256 tool to verify with"; return 0; fi
    [ "$sc_got" = "$sc_want" ] || die "$sc_file is damaged or incomplete (checksum mismatch); download it again"
    SELF_CHECK="ok"
}

# --- HTTP (curl, GNU/BusyBox wget, or OpenWrt's uclient-fetch) ---------------------------------------------
# Device endpoints are asked with ?soft=1: Telepy then always answers 200 and puts the real status in a first
# line STATUS=…, because wget / uclient-fetch neither show the status code nor keep an error body.
# Sets HTTP_STATUS and HTTP_BODY; returns 1 when nothing came back (network, TLS, timeout).
HTTP_TIMEOUT=25
http() {
    h_url=$2
    case "$h_url" in *\?*) h_url="$h_url&soft=1" ;; *) h_url="$h_url?soft=1" ;; esac
    HTTP_ERR=""
    case "$HTTP_TOOL" in
        curl)
            if [ "$#" -ge 3 ]; then
                HTTP_OUT=$(curl -sS --connect-timeout 10 --max-time "$HTTP_TIMEOUT" -X "$1" -H 'Content-Type: application/json' --data "$3" "$h_url" 2>"$TMP/http.err") || { HTTP_ERR=$(cat "$TMP/http.err"); return 1; }
            else
                HTTP_OUT=$(curl -sS --connect-timeout 10 --max-time "$HTTP_TIMEOUT" "$h_url" 2>"$TMP/http.err") || { HTTP_ERR=$(cat "$TMP/http.err"); return 1; }
            fi ;;
        *)
            if [ "$#" -ge 3 ]; then
                HTTP_OUT=$("$HTTP_TOOL" -q -T "$HTTP_TIMEOUT" -O - --post-data="$3" "$h_url" 2>"$TMP/http.err") || { HTTP_ERR=$(cat "$TMP/http.err"); return 1; }
            else
                HTTP_OUT=$("$HTTP_TOOL" -q -T "$HTTP_TIMEOUT" -O - "$h_url" 2>"$TMP/http.err") || { HTTP_ERR=$(cat "$TMP/http.err"); return 1; }
            fi ;;
    esac
    HTTP_STATUS=$(printf '%s\n' "$HTTP_OUT" | sed -n '1s/^STATUS=\([0-9]*\)$/\1/p')
    [ -n "$HTTP_STATUS" ] || { HTTP_ERR="the answer did not come from Telepy (no STATUS line): $(printf '%s' "$HTTP_OUT" | head -c 120)"; return 1; }
    HTTP_BODY=$(printf '%s\n' "$HTTP_OUT" | sed '1d')
    return 0
}
# A plain download (no STATUS line): the WebSocket carrier.
http_raw() {
    case "$HTTP_TOOL" in
        curl) curl -fsS --connect-timeout 10 --max-time 60 "$1" 2>/dev/null ;;
        *) "$HTTP_TOOL" -q -T 60 -O - "$1" 2>/dev/null ;;
    esac
}
http_hint() {
    case "$TELEPY_URL" in
        https://*) [ "$HTTP_TOOL" = curl ] || note "https with $HTTP_TOOL needs CA certificates ($(pkg_hint ca); a wrong clock also fails TLS)" ;;
    esac
    [ -z "$HTTP_ERR" ] || note "$(printf '%s' "$HTTP_ERR" | tail -n 1 | cut -c1-200)"
}
value() { printf '%s\n' "$HTTP_BODY" | sed -n "s/^$1=//p" | head -n 1; }
values() { printf '%s\n' "$HTTP_BODY" | sed -n "s/^$1=//p"; }

# --- host key verification -----------------------------------------------------------------------------------
# verify_host_key TYPE BASE64 → 0 when a strict handshake with exactly this key succeeds (the connection gets past
# the host-key check; authentication is not attempted, so "Permission denied" is the success marker for OpenSSH).
# 1 = mismatch (the server has another key), 2 = no server / cannot connect, 3 = could not tell.
verify_host_key() {
    vh_type=$1; vh_key=$2
    vh_kh="$TMP/verify.known_hosts"
    case "$CLIENT" in
        openssh)
            printf 'telepy-local %s %s\n' "$vh_type" "$vh_key" > "$vh_kh"
            vh_algs=$vh_type
            [ "$vh_type" = ssh-rsa ] && vh_algs="rsa-sha2-512,rsa-sha2-256,ssh-rsa"
            vh_out=$(with_timeout 20 "$SSH_BIN" -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$vh_kh" \
                -o HostKeyAlias=telepy-local -o "HostKeyAlgorithms=$vh_algs" -o PubkeyAuthentication=no -o PasswordAuthentication=no \
                -o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes -o LogLevel=ERROR -p "$SSH_PORT" "telepy-probe@$SSH_HOST" true 2>&1 </dev/null) || true
            case "$vh_out" in
                *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION"*|*"host key for"*"differs"*) return 1 ;;
                *"Permission denied"*|*"no more authentication"*) return 0 ;;
                *"Connection refused"*|*"timed out"*|*"Timeout"*|*"Could not resolve"*|*"No route"*|*"Connection reset"*|*"Connection closed"*) return 2 ;;
                *"no matching host key type"*) return 3 ;;
                *) return 3 ;;
            esac ;;
        dbclient)
            # No usable key and no tty: a completed handshake ends in "exited: Interrupted." (password prompt without a
            # tty) or "exited: No auth methods could be used."; -i /dev/null would crash dbclient 2022.82 ("Bad buf_getptr").
            mkdir -p "$TMP/probe-home/.ssh"
            printf '%s %s %s\n' "$SSH_HOST" "$vh_type" "$vh_key" > "$TMP/probe-home/.ssh/known_hosts"
            vh_out=$(HOME="$TMP/probe-home" with_timeout 20 "$SSH_BIN" -i "$TMP/no-such-key" -p "$SSH_PORT" "telepy-probe@$SSH_HOST" true 2>&1 </dev/null) || true
            case "$vh_out" in
                *"host key mismatch"*|*"Didn't validate host key"*|*"not in the trusted hosts"*) return 1 ;;
                *"Connect failed"*|*"Connection refused"*|*"timed out"*|*"Remote closed the connection"*) return 2 ;;
                *"exited: "*) return 0 ;;
                *) return 3 ;;
            esac ;;
    esac
    return 3
}

# Add "TYPE BASE64" from SOURCE to the candidate list once.
add_candidate() {
    case "$1" in ssh-*|ecdsa-*|sk-*) ;; *) return 0 ;; esac
    case "$2" in ""|*[!A-Za-z0-9+/=]*) return 0 ;; esac
    case "$CANDIDATES" in *"|$1 $2|"*) return 0 ;; esac
    CANDIDATES="$CANDIDATES$3|$1 $2|
"
}

# --- gateway probe --------------------------------------------------------------------------------------------
# probe_gateway EXTRA_SSH_OPTS → GW_PROBE=ok | timeout | hostkey | unreachable | other, the client's output in GW_PROBE_OUT.
# No key is offered (PubkeyAuthentication=no): a full key exchange with the pinned host key ends in
# "Permission denied", and the gateway logs nothing for it.
probe_gateway() {
    case "$CLIENT" in
        openssh)
            # shellcheck disable=SC2086
            GW_PROBE_OUT=$(with_timeout 30 "$SSH_BIN" -F /dev/null -o BatchMode=yes -o "StrictHostKeyChecking=$STRICT" -o "UserKnownHostsFile=$KNOWN_HOSTS" \
                -o "HostKeyAlias=$ALIAS" -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes \
                -o LogLevel=ERROR $1 $PROXY_OPT -p "$GATEWAY_PORT" "$GATEWAY_USER@$GATEWAY_HOST" true 2>&1 </dev/null) || true
            case "$GW_PROBE_OUT" in
                *"Permission denied"*) GW_PROBE=ok ;;
                *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION"*) GW_PROBE=hostkey ;;
                *"timed out"*|*"Timeout"*|*"timeout"*) GW_PROBE=timeout ;;
                *"Connection refused"*|*"No route"*|*"Could not resolve"*|*"Network is unreachable"*|*"Connection reset"*) GW_PROBE=unreachable ;;
                "") GW_PROBE=timeout ;;
                *) GW_PROBE=other ;;
            esac ;;
        dbclient)
            # shellcheck disable=SC2086
            GW_PROBE_OUT=$(HOME="$TMP/gw-home" with_timeout 30 "$SSH_BIN" -i "$TMP/no-such-key" $PROXY_J -p "$GATEWAY_PORT" "$GATEWAY_USER@$GATEWAY_HOST" true 2>&1 </dev/null) || true
            case "$GW_PROBE_OUT" in
                *"host key mismatch"*|*"Didn't validate host key"*|*"not in the trusted hosts"*) GW_PROBE=hostkey ;;
                *"Connect failed"*|*"Connection refused"*|*"No route"*|*"Network is unreachable"*) GW_PROBE=unreachable ;;
                *"Remote closed the connection"*) GW_PROBE=closed ;;
                *"timed out"*|*"Timeout"*) GW_PROBE=timeout ;;
                *"exited: "*) GW_PROBE=ok ;;
                "") GW_PROBE=timeout ;;
                *) GW_PROBE=other ;;
            esac ;;
    esac
}
gw_last() {
    if [ -n "$GW_PROBE_OUT" ]; then printf '%s' "$GW_PROBE_OUT" | tail -n 1 | cut -c1-120; else printf 'the connection ended without a message'; fi
}

# --- the install record (no secrets) --------------------------------------------------------------------------
record() { printf '%s=%s\n' "$1" "$2" >> "$RECORD"; }

write_uninstall() {
    {
        printf '#!/bin/sh\n# Stops and removes the Telepy tunnel %s (#%s) installed by the join script.\n' "$INSTALL_ID" "$TUNNEL_ID"
        printf '%s\n' "$1"
        if [ -n "$DB_KH_LINES" ]; then
            # Only the exact known_hosts lines this install added (dbclient has no separate known_hosts file).
            printf 'if [ -f %s ]; then grep -vxF' "$DB_KH" ; printf '%s\n' "$DB_KH_LINES" | while IFS= read -r l; do if [ -n "$l" ]; then printf " -e '%s'" "$l"; fi; done
            printf ' %s > %s.telepy-tmp; cat %s.telepy-tmp > %s; rm -f %s.telepy-tmp; fi\n' "$DB_KH" "$DB_KH" "$DB_KH" "$DB_KH" "$DB_KH"
        fi
        printf 'rm -f %s %s %s\n' "$KNOWN_HOSTS" "$RECORD" "$UNINSTALL"
        printf 'echo "Stopped the tunnel. The key %s and the Telepy line in %s were kept; delete them if you no longer need them."\n' "$KEY" "$AUTH_KEYS"
    } > "$UNINSTALL"
    chmod 700 "$UNINSTALL"
    [ "$IS_ROOT" -eq 1 ] && chown "$TARGET_USER:$TARGET_GROUP" "$UNINSTALL" 2>/dev/null
    return 0
}

# --- service installers; each sets SERVICE_KIND, SERVICE_NAME, SERVICE_FILE, BOOT (yes/no), RUNNING (yes/no/unknown), LOGS ---
start_background() {
    RUNNER="$SSH_DIR/$UNIT.sh"
    LOG_FILE="$SSH_DIR/$UNIT.log"
    {
        printf '#!/bin/sh\n# Telepy reverse tunnel %s: reconnects forever.\nexport HOME=%s\n' "$INSTALL_ID" "$TARGET_HOME"
        printf 'while :; do\n    %s %s\n    sleep 10\ndone\n' "$SSH_BIN" "$SSH_ARGS"
    } > "$RUNNER"
    chmod 700 "$RUNNER"
    # Stop a previous loop and its ssh child (re-runs). The old ssh child is found by this tunnel's own known_hosts
    # file (OpenSSH) or key file (dbclient): -R asks for 0, so the number cannot identify it.
    PATTERN="UserKnownHostsFile=$KNOWN_HOSTS "
    [ "$CLIENT" = dbclient ] && PATTERN="-i $KEY "
    pkill -f "$RUNNER" 2>/dev/null || true
    pkill -f "$PATTERN" 2>/dev/null || true
    nohup "$RUNNER" > "$LOG_FILE" 2>&1 &
    FILES="$FILES $RUNNER $LOG_FILE"
    LOGS="tail -f $LOG_FILE"
    SERVICE_KIND=loop; SERVICE_NAME=$RUNNER; SERVICE_FILE=$RUNNER
    sleep 1
    if pgrep -f "$RUNNER" >/dev/null 2>&1; then RUNNING=yes; else RUNNING=no; fi
    BOOT_CMD="pkill -f $RUNNER; pkill -f '$PATTERN'"
    BOOT=no
    if have crontab; then
        if { crontab -l 2>/dev/null | grep -vF "$RUNNER"; printf '@reboot %s >%s 2>&1\n' "$RUNNER" "$LOG_FILE"; } | crontab - 2>/dev/null; then
            if crontab -l 2>/dev/null | grep -qF "$RUNNER"; then BOOT=yes; fi
            BOOT_CMD="$BOOT_CMD; crontab -l 2>/dev/null | grep -vF $RUNNER | crontab -"
        fi
    fi
    if [ "$BOOT" = yes ]; then say "started in the background; a crontab @reboot entry starts it after a reboot"
    else warn "started in the background, but it will NOT come back after a reboot (no service manager, or crontab failed)"; fi
    write_uninstall "$BOOT_CMD; rm -f $RUNNER $LOG_FILE"
}

install_procd() {
    INIT_FILE="/etc/init.d/$UNIT"
    {
        printf '#!/bin/sh /etc/rc.common\n# Telepy reverse tunnel %s (installed by the Telepy join script; record: %s)\n' "$INSTALL_ID" "$RECORD"
        printf 'USE_PROCD=1\nSTART=99\nSTOP=10\n\nstart_service() {\n    procd_open_instance\n'
        printf '    procd_set_param command %s' "$SSH_BIN"
        for arg in $SSH_ARGS; do printf ' %s' "$arg"; done
        printf '\n'
        # respawn <threshold> <timeout> <retry>: restart 10 s after every exit, forever (0). Before the network is up
        # ssh simply fails and is started again; nothing else is needed for boot ordering.
        printf '    procd_set_param respawn 3600 10 0\n    procd_set_param stdout 1\n    procd_set_param stderr 1\n'
        printf '    procd_set_param env HOME=%s\n' "$TARGET_HOME"
        [ "$TARGET_USER" = root ] || printf '    procd_set_param user %s\n' "$TARGET_USER"
        printf '    procd_close_instance\n}\n'
    } > "$INIT_FILE"
    chmod 755 "$INIT_FILE"
    "$INIT_FILE" enable >/dev/null 2>&1 || die "$INIT_FILE enable failed"
    # A fresh service is started; only an already running one is restarted (procd's restart on an unknown service
    # prints a misleading "Not found" from its stop phase).
    if "$INIT_FILE" running >/dev/null 2>&1; then
        "$INIT_FILE" restart || die "$INIT_FILE restart failed"
    else
        "$INIT_FILE" start || die "$INIT_FILE start failed"
    fi
    sleep 1
    if "$INIT_FILE" running >/dev/null 2>&1; then RUNNING=yes; else RUNNING=no; fi
    if "$INIT_FILE" enabled >/dev/null 2>&1; then BOOT=yes; else BOOT=no; fi
    FILES="$FILES $INIT_FILE"
    LOGS="logread -e $UNIT   # or: logread | grep $(basename "$SSH_BIN")"
    SERVICE_KIND=procd; SERVICE_NAME=$UNIT; SERVICE_FILE=$INIT_FILE
    say "installed the procd service $UNIT (/etc/init.d/$UNIT)"
    write_uninstall "$INIT_FILE stop 2>/dev/null; $INIT_FILE disable 2>/dev/null; rm -f $INIT_FILE"
}

install_systemd_system() {
    UNIT_FILE="/etc/systemd/system/$UNIT.service"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Telepy reverse tunnel $INSTALL_ID
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=$TARGET_USER
Environment=HOME=$TARGET_HOME
ExecStart=$SSH_BIN $SSH_ARGS
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$UNIT.service" >/dev/null 2>&1 || die "systemctl enable $UNIT failed"
    systemctl restart "$UNIT.service" || die "systemctl restart $UNIT failed (journalctl -u $UNIT)"
    sleep 1
    if systemctl is-active --quiet "$UNIT.service"; then RUNNING=yes; else RUNNING=no; fi
    if systemctl is-enabled --quiet "$UNIT.service" 2>/dev/null; then BOOT=yes; else BOOT=no; fi
    FILES="$FILES $UNIT_FILE"
    LOGS="journalctl -u $UNIT -f"
    SERVICE_KIND=systemd; SERVICE_NAME="$UNIT.service"; SERVICE_FILE=$UNIT_FILE
    say "installed the systemd service $UNIT"
    write_uninstall "systemctl disable --now $UNIT.service; rm -f $UNIT_FILE; systemctl daemon-reload"
}

install_systemd_user() {
    UNIT_DIR="$TARGET_HOME/.config/systemd/user"
    UNIT_FILE="$UNIT_DIR/$UNIT.service"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Telepy reverse tunnel $INSTALL_ID
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
    sleep 1
    if systemctl --user is-active --quiet "$UNIT.service"; then RUNNING=yes; else RUNNING=no; fi
    if systemctl --user is-enabled --quiet "$UNIT.service" 2>/dev/null; then BOOT=yes; else BOOT=no; fi
    FILES="$FILES $UNIT_FILE"
    LOGS="journalctl --user -u $UNIT -f"
    SERVICE_KIND=systemd-user; SERVICE_NAME="$UNIT.service"; SERVICE_FILE=$UNIT_FILE
    say "installed the user service $UNIT"
    if ! loginctl show-user "$CURRENT_USER" -p Linger 2>/dev/null | grep -q '=yes' && ! loginctl enable-linger "$CURRENT_USER" >/dev/null 2>&1; then
        warn "the tunnel stops when $CURRENT_USER logs out. To keep it running, run: sudo loginctl enable-linger $CURRENT_USER (or re-run this script with sudo)"
        BOOT=login
    fi
    write_uninstall "systemctl --user disable --now $UNIT.service; rm -f $UNIT_FILE; systemctl --user daemon-reload"
}

install_launchd() {
    LABEL="com.telepy.tunnel.$INSTALL_ID"
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
    sleep 1
    if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then RUNNING=yes; else RUNNING=unknown; fi
    BOOT=yes
    FILES="$FILES $PLIST $LOG_FILE"
    LOGS="tail -f $LOG_FILE"
    SERVICE_KIND=launchd; SERVICE_NAME=$LABEL; SERVICE_FILE=$PLIST
    say "installed the launchd job $LABEL"
    [ "$IS_ROOT" -eq 0 ] && { warn "as a LaunchAgent the tunnel runs while $CURRENT_USER is logged in; re-run with sudo to keep it running all the time"; BOOT=login; }
    write_uninstall "launchctl bootout $DOMAIN/$LABEL 2>/dev/null || launchctl unload -w $PLIST 2>/dev/null; rm -f $PLIST $LOG_FILE"
}

# An earlier one-command install of this tunnel under the older names (telepy-tunnel-<number>): stop and remove it,
# so the two do not fight over the tunnel. The shared ~/.ssh/telepy_known_hosts stays (other tools may use it).
remove_older_join() {
    OLD="telepy-tunnel-$TUNNEL_ID"
    [ "$UNIT" = "$OLD" ] && return 0
    found=0
    if [ "$IS_ROOT" -eq 1 ] && [ -f "/etc/systemd/system/$OLD.service" ]; then
        systemctl disable --now "$OLD.service" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/$OLD.service"
        systemctl daemon-reload >/dev/null 2>&1 || true
        found=1
    fi
    if [ "$IS_ROOT" -eq 0 ] && [ -f "$TARGET_HOME/.config/systemd/user/$OLD.service" ]; then
        systemctl --user disable --now "$OLD.service" >/dev/null 2>&1 || true
        rm -f "$TARGET_HOME/.config/systemd/user/$OLD.service"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        found=1
    fi
    for p in "/Library/LaunchDaemons/com.telepy.tunnel.$TUNNEL_ID.plist" "$TARGET_HOME/Library/LaunchAgents/com.telepy.tunnel.$TUNNEL_ID.plist"; do
        [ -f "$p" ] || continue
        case "$p" in
            /Library/*)
                [ "$IS_ROOT" -eq 1 ] || continue
                launchctl bootout "system/com.telepy.tunnel.$TUNNEL_ID" >/dev/null 2>&1 || true ;;
            *)
                launchctl bootout "gui/$(id -u)/com.telepy.tunnel.$TUNNEL_ID" >/dev/null 2>&1 || launchctl bootout "user/$(id -u)/com.telepy.tunnel.$TUNNEL_ID" >/dev/null 2>&1 || true ;;
        esac
        rm -f "$p" "$TARGET_HOME/Library/Logs/$OLD.log"
        found=1
    done
    if [ -f "$SSH_DIR/$OLD.sh" ]; then
        pkill -f "$SSH_DIR/$OLD.sh" 2>/dev/null || true
        # Its ssh child: the older join wrote the shared known_hosts plus this server's alias.
        pkill -f "UserKnownHostsFile=$SSH_DIR/telepy_known_hosts -o HostKeyAlias=$ALIAS " 2>/dev/null || true
        if crontab -l 2>/dev/null | grep -qF "$SSH_DIR/$OLD.sh"; then
            crontab -l 2>/dev/null | grep -vF "$SSH_DIR/$OLD.sh" | crontab - 2>/dev/null || true
        fi
        rm -f "$SSH_DIR/$OLD.sh" "$SSH_DIR/$OLD.log"
        found=1
    fi
    rm -f "$SSH_DIR/telepy-uninstall-$TUNNEL_ID.sh" "$SSH_DIR/telepy-ws-$TUNNEL_ID.py" "$SSH_DIR/telepy-ws-$TUNNEL_ID.sh"
    [ "$found" -eq 0 ] || say "removed the earlier install of this tunnel ($OLD)"
    return 0
}

# ==================================================================================================================
main() {
    TOKEN=""
    CHECK_ONLY=0
    TARGET_USER=""
    SSH_PORT=""
    SSH_HOST=""
    AUTH_KEYS_OPT=""
    CLIENT_OPT=""
    SERVICE_OPT=""
    NAME=""
    COMPAT_OPT=auto
    VIA_WEB=0
    SSH_DIR_OPT=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --token|--user|--ssh-port|--ssh-host|--authorized-keys|--client|--service|--name|--ssh-dir)
                [ "$#" -ge 2 ] || die "$1 needs a value"
                case "$1" in
                    --token) TOKEN=$2 ;;
                    --user) TARGET_USER=$2 ;;
                    --ssh-port) SSH_PORT=$2 ;;
                    --ssh-host) SSH_HOST=$2 ;;
                    --authorized-keys) AUTH_KEYS_OPT=$2 ;;
                    --client) CLIENT_OPT=$2 ;;
                    --service) SERVICE_OPT=$2 ;;
                    --name) NAME=$2 ;;
                    --ssh-dir) SSH_DIR_OPT=$2 ;;
                esac
                shift 2 ;;
            --token=*) TOKEN=${1#*=}; shift ;;
            --user=*) TARGET_USER=${1#*=}; shift ;;
            --ssh-port=*) SSH_PORT=${1#*=}; shift ;;
            --ssh-host=*) SSH_HOST=${1#*=}; shift ;;
            --authorized-keys=*) AUTH_KEYS_OPT=${1#*=}; shift ;;
            --client=*) CLIENT_OPT=${1#*=}; shift ;;
            --service=*) SERVICE_OPT=${1#*=}; shift ;;
            --name=*) NAME=${1#*=}; shift ;;
            --ssh-dir=*) SSH_DIR_OPT=${1#*=}; shift ;;
            --check) CHECK_ONLY=1; shift ;;
            --no-service) SERVICE_OPT=loop; shift ;;
            --compat-no-server-alive) COMPAT_OPT=force; shift ;;
            --no-compat) COMPAT_OPT=never; shift ;;
            --via-web) VIA_WEB=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
    done

    case "$TOKEN" in
        "") [ "$CHECK_ONLY" -eq 1 ] || die "missing --token (copy the whole command from Telepy, or run with --check first)" ;;
        *[!A-Za-z0-9_-]*) die "the token looks wrong; copy the whole command from Telepy again" ;;
    esac
    case "$NAME" in *[!A-Za-z0-9._-]*) die "--name may only use letters, digits, '.', '_' and '-'" ;; esac
    case "$SSH_PORT" in ""|*[!0-9]*) [ -z "$SSH_PORT" ] || die "--ssh-port must be a number" ;; esac
    case "$SSH_HOST" in *[!A-Za-z0-9.:_-]*) die "--ssh-host must be an address" ;; esac
    case "$CLIENT_OPT" in ""|openssh|dbclient) ;; *) die "--client must be openssh or dbclient" ;; esac
    case "$SERVICE_OPT" in ""|procd|systemd|launchd|loop) ;; *) die "--service must be procd, systemd, launchd or loop" ;; esac

    TMP=$(mktemp -d 2>/dev/null || mktemp -d -t telepy-join) || die "cannot create a temporary directory"
    chmod 700 "$TMP"
    trap 'rm -rf "$TMP"' EXIT INT TERM
    SELF_CHECK=""
    self_check "$0"

    # ---------------------------------------------------------------------------------------------------------
    step "What this machine has"
    OS=$(uname -s)
    ARCH=$(uname -m 2>/dev/null || echo unknown)
    if [ -f /etc/openwrt_release ]; then
        DISTRO="OpenWrt $(sed -n "s/^DISTRIB_RELEASE='\(.*\)'$/\1/p" /etc/openwrt_release | head -n 1)"
        OPENWRT=1
    elif [ "$OS" = Darwin ]; then
        DISTRO="macOS $(sw_vers -productVersion 2>/dev/null || true)"
        OPENWRT=0
    elif [ -r /etc/os-release ]; then
        DISTRO=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release | head -n 1)
        OPENWRT=0
    else
        DISTRO=$OS
        OPENWRT=0
    fi
    SHELL_KIND=sh
    if sh --help 2>&1 | head -n 1 | grep -q BusyBox; then
        SHELL_KIND="ash ($(sh --help 2>&1 | head -n 1 | sed 's/ multi-call.*//; s/ (.*//'))"
    elif [ -n "${BASH_VERSION:-}" ]; then SHELL_KIND="bash $BASH_VERSION"
    elif sh --version 2>/dev/null | head -n 1 | grep -qi bash; then SHELL_KIND="bash (as sh)"
    elif [ -f /etc/debian_version ] && [ "$(readlink -f /bin/sh 2>/dev/null)" = /usr/bin/dash ]; then SHELL_KIND=dash
    fi
    note "system: $DISTRO ($OS $ARCH); shell: $SHELL_KIND"
    [ -z "$SELF_CHECK" ] || note "this file: $SELF_CHECK"

    TIMEOUT_BIN=""
    if have timeout; then TIMEOUT_BIN=timeout; elif have gtimeout; then TIMEOUT_BIN=gtimeout; fi
    # Package manager, for the "install X" hints only (never used to install anything here).
    PKG=""
    for p in opkg apk apt-get dnf yum zypper pacman brew pkg; do
        if have "$p"; then PKG=$p; break; fi
    done
    [ "$PKG" = apt-get ] && PKG=apt
    [ -z "$PKG" ] || note "packages: $PKG (hints only; this script installs nothing)"
    HTTP_TOOL=""
    if have curl; then HTTP_TOOL=curl
    elif have wget && wget --help 2>&1 | grep -q -- '--post-data'; then HTTP_TOOL=wget
    elif have uclient-fetch; then HTTP_TOOL=uclient-fetch
    elif have wget; then HTTP_TOOL=wget
    fi
    [ -n "$HTTP_TOOL" ] || die "no HTTP tool found (curl, wget or uclient-fetch): $(pkg_hint curl)"
    if [ -n "$TIMEOUT_BIN" ]; then note "http: $HTTP_TOOL; timeout: $TIMEOUT_BIN"; else note "http: $HTTP_TOOL; timeout: built-in watchdog"; fi

    # The SSH client that will run the tunnel. "ssh" is not always OpenSSH: stock OpenWrt's /usr/bin/ssh is dbclient.
    CLIENT=""; SSH_BIN=""; CLIENT_DESC=""
    for cand in ssh dbclient; do
        have "$cand" || continue
        bin=$(command -v "$cand")
        ver=$("$bin" -V 2>&1 | head -n 1)
        case "$ver" in
            OpenSSH_*)
                [ "$CLIENT_OPT" = dbclient ] && continue
                CLIENT=openssh; SSH_BIN=$bin; CLIENT_DESC=$(printf '%s' "$ver" | sed 's/,.*//; s/ .*//')
                break ;;
            *[Dd]ropbear*)
                [ "$CLIENT_OPT" = openssh ] && continue
                # Prefer a real OpenSSH further down the PATH (e.g. dbclient first, OpenSSH installed later).
                # The service must name the dbclient binary itself, never the `ssh` link: installing openssh-client later
                # repoints /usr/bin/ssh, and OpenSSH would then be started with dbclient's options.
                if [ -z "$CLIENT" ]; then
                    CLIENT=dbclient
                    SSH_BIN=$(command -v dbclient 2>/dev/null || printf '%s' "$bin")
                    CLIENT_DESC="dbclient $(printf '%s' "$ver" | sed 's/.*v\([0-9.]*\).*/\1/')"
                fi ;;
        esac
    done
    if [ -z "$CLIENT" ]; then
        case "$CLIENT_OPT" in
            openssh) die "no OpenSSH client found (ssh -V does not say OpenSSH): $(pkg_hint openssh)" ;;
            dbclient) die "no dbclient found: $(pkg_hint dropbear)" ;;
            *) die "no SSH client found: $(pkg_hint openssh), or Dropbear's dbclient ($(pkg_hint dropbear))" ;;
        esac
    fi
    case "$CLIENT" in
        openssh)
            # Every option the tunnel will use must be accepted by this build (-G parses without connecting).
            if "$SSH_BIN" -G -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -o IdentitiesOnly=yes \
                -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/dev/null -o HostKeyAlias=telepy-x -o TCPKeepAlive=yes -p 22 -R 0:localhost:22 telepy@example.invalid >/dev/null 2>&1; then
                note "ssh client: $CLIENT_DESC at $SSH_BIN (all options accepted)"
            else
                warn "$SSH_BIN ($CLIENT_DESC) did not accept the tunnel options with -G; a very old OpenSSH may still work, but this is unverified"
                note "ssh client: $CLIENT_DESC at $SSH_BIN (options NOT verified)"
            fi
            have ssh-keygen || die "ssh-keygen is missing ($(pkg_hint openssh)), or run with --client dbclient" ;;
        dbclient)
            # dbclient ignores unknown -o options and still exits 0, so the capability list (-o help) decides, not the exit code.
            dbclient -o help 2>&1 | grep -q 'ExitOnForwardFailure' || die "$SSH_BIN ($CLIENT_DESC) has no ExitOnForwardFailure option (Dropbear 2016.73 or newer is needed)"
            "$SSH_BIN" -h 2>&1 | grep -q -- '-K <keepalive>' || die "$SSH_BIN ($CLIENT_DESC) has no -K keepalive option"
            "$SSH_BIN" -h 2>&1 | grep -q -- '-R <' || die "$SSH_BIN ($CLIENT_DESC) was built without remote port forwarding"
            have dropbearkey || die "dropbearkey is missing ($(pkg_hint dropbear))"
            note "ssh client: $CLIENT_DESC at $SSH_BIN (has -R, -K, ExitOnForwardFailure; host key via ~/.ssh/known_hosts)" ;;
    esac
    PYTHON=""
    if [ "$VIA_WEB" -eq 1 ]; then
        PYTHON=$(command -v python3 || true)
        [ -n "$PYTHON" ] || die "--via-web needs python3 on this machine (it carries the SSH connection inside a WebSocket)"
    fi

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
    TARGET_UID=$(id -u "$TARGET_USER")
    SSH_DIR=${SSH_DIR_OPT:-"$TARGET_HOME/.ssh"}
    case "$SSH_DIR" in *[!A-Za-z0-9._/-]*) die "unsupported --ssh-dir path: $SSH_DIR" ;; esac
    fs=$(fs_type "$SSH_DIR")
    case "$fs" in tmpfs|ramfs) warn "$SSH_DIR is on $fs: everything written there is lost at reboot (pass --ssh-dir)" ;; esac
    note "login account: $TARGET_USER (uid $TARGET_UID, home $TARGET_HOME); installer: $CURRENT_USER$([ "$IS_ROOT" -eq 1 ] && printf ' (root)')"

    # --- service manager -------------------------------------------------------------------------------------
    SERVICE=""
    if [ -n "$SERVICE_OPT" ]; then
        SERVICE=$SERVICE_OPT
        case "$SERVICE" in
            procd) { [ -f /etc/rc.common ] && [ -d /etc/init.d ]; } || die "--service procd: this is not an OpenWrt-style system (/etc/rc.common)"
                   [ "$IS_ROOT" -eq 1 ] || die "--service procd needs root (writes /etc/init.d)" ;;
            systemd) have systemctl || die "--service systemd: no systemctl" ;;
            launchd) have launchctl || die "--service launchd: no launchctl" ;;
        esac
    elif [ "$OS" = Linux ] && [ "$IS_ROOT" -eq 1 ] && [ -x /sbin/procd ] && [ -f /etc/rc.common ] && [ -d /etc/init.d ] && pidof procd >/dev/null 2>&1; then
        SERVICE=procd
    elif [ "$OS" = Linux ] && [ "$IS_ROOT" -eq 1 ] && have systemctl && [ -d /run/systemd/system ]; then
        SERVICE=systemd
    elif [ "$OS" = Linux ] && [ "$IS_ROOT" -eq 0 ] && have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
        SERVICE=systemd
    elif [ "$OS" = Darwin ] && have launchctl; then
        SERVICE=launchd
    else
        SERVICE=loop
    fi
    case "$SERVICE" in
        procd) SERVICE_DESC="procd (/etc/init.d, logread)" ;;
        systemd) if [ "$IS_ROOT" -eq 1 ]; then SERVICE_DESC="systemd (system unit)"; else SERVICE_DESC="systemd --user (stops at logout unless lingering)"; fi ;;
        launchd) if [ "$IS_ROOT" -eq 1 ]; then SERVICE_DESC="launchd (LaunchDaemon)"; else SERVICE_DESC="launchd (LaunchAgent, while logged in)"; fi ;;
        loop) if have crontab; then SERVICE_DESC="background loop + @reboot crontab"; else SERVICE_DESC="background loop only (no crontab: not restarted at boot)"; fi ;;
    esac
    note "service manager: $SERVICE_DESC"

    # --- this machine's SSH server ------------------------------------------------------------------
    SERVER_KIND=unknown
    SERVER_DESC=""
    if [ -z "$SSH_PORT" ]; then
        if [ "$OPENWRT" -eq 1 ] && have uci; then
            SSH_PORT=$(uci -q get dropbear.@dropbear[0].Port 2>/dev/null | head -n 1 || true)
        fi
        [ -n "$SSH_PORT" ] || SSH_PORT=$( { sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || true; } | awk '$1 == "port" { print $2; exit }')
        [ -n "$SSH_PORT" ] || SSH_PORT=22
    fi
    step "Checking the SSH server on port $SSH_PORT"
    # Who listens on that port, and on which address? (Dropbear bound to the LAN interface only does not answer on
    # 127.0.0.1; the host-key check and the tunnel's target must then use that LAN address.)
    LISTEN_ADDRS=""
    if [ -r /proc/net/tcp ]; then
        hexport=$(printf '%04X' "$SSH_PORT")
        LISTEN_ADDRS=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p="$hexport" '$4 == "0A" { split($2, a, ":"); if (a[2] == p) print a[1] }' | sort -u)
    fi
    if [ -z "$SSH_HOST" ]; then
        SSH_HOST=127.0.0.1
        if [ -n "$LISTEN_ADDRS" ]; then
            if printf '%s\n' "$LISTEN_ADDRS" | grep -qE '^(00000000|0100007F|00000000000000000000000000000000|0000000000000000FFFF00000100007F)$'; then
                SSH_HOST=127.0.0.1
            else
                # Little-endian hex IPv4 (e.g. 0101A8C0 = 192.168.1.1): use the first bound address.
                first=$(printf '%s\n' "$LISTEN_ADDRS" | grep -E '^[0-9A-F]{8}$' | head -n 1)
                if [ -n "$first" ]; then
                    SSH_HOST=$(printf '%d.%d.%d.%d' "0x$(printf '%s' "$first" | cut -c7-8)" "0x$(printf '%s' "$first" | cut -c5-6)" "0x$(printf '%s' "$first" | cut -c3-4)" "0x$(printf '%s' "$first" | cut -c1-2)")
                    note "the SSH server listens only on $SSH_HOST (not on 127.0.0.1): the tunnel will target that address"
                fi
            fi
        fi
    elif [ -n "$LISTEN_ADDRS" ]; then
        note "listening sockets on port $SSH_PORT: $(printf '%s' "$LISTEN_ADDRS" | tr '\n' ' ')"
    fi
    [ -r /proc/net/tcp ] && [ -z "$LISTEN_ADDRS" ] && warn "nothing seems to listen on TCP port $SSH_PORT (checked /proc/net/tcp)"
    # The server's banner says what it is (ssh-keyscan is not needed for that).
    BANNER=""
    PROBE_REFUSED=0
    if have nc; then
        # -w: give up after 3 s (macOS and most BusyBox builds); the GL.iNet BusyBox nc has no -w and prints its usage
        # instead, so a second try runs nc under the watchdog. The server sends its banner first.
        BANNER=$(printf '' | nc -w 3 "$SSH_HOST" "$SSH_PORT" 2>/dev/null | head -n 1 | tr -d '\r' || true)
        case "$BANNER" in SSH-*) ;; *) BANNER=$(with_timeout 3 nc "$SSH_HOST" "$SSH_PORT" 2>/dev/null </dev/null | head -n 1 | tr -d '\r' || true) ;; esac
        case "$BANNER" in SSH-*) ;; *) BANNER="" ;; esac
    fi
    if [ -z "$BANNER" ] && [ "$CLIENT" = openssh ]; then
        vout=$(with_timeout 10 "$SSH_BIN" -F /dev/null -v -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
            -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -p "$SSH_PORT" "telepy-probe@$SSH_HOST" true 2>&1 </dev/null || true)
        BANNER=$(printf '%s\n' "$vout" | sed -n 's/.*remote software version /SSH-2.0-/p' | head -n 1)
        case "$vout" in *"Connection refused"*|*"timed out"*|*"No route"*|*"Network is unreachable"*) PROBE_REFUSED=1 ;; esac
    fi
    case "$BANNER" in
        SSH-*dropbear*)
            # OpenWrt's Dropbear hides its version in the banner ("SSH-2.0-dropbear"); the local binary knows it.
            SERVER_KIND=dropbear
            dbver=$(printf '%s' "$BANNER" | sed 's/.*dropbear_\{0,1\}//; s/[^0-9.].*//')
            [ -n "$dbver" ] || { have dropbear && dbver=$(dropbear -V 2>&1 | sed -n 's/.*v\([0-9.]*\).*/\1/p' | head -n 1); } || true
            SERVER_DESC="Dropbear${dbver:+ $dbver}" ;;
        SSH-*OpenSSH*) SERVER_KIND=openssh; SERVER_DESC=$(printf '%s' "$BANNER" | sed 's/^SSH-[0-9.]* //; s/ .*//') ;;
        SSH-*) SERVER_KIND=other; SERVER_DESC=$(printf '%s' "$BANNER" | sed 's/^SSH-[0-9.]* //') ;;
        "")
            # No banner and nothing refused the connection: decide by what is installed (the handshake below still has to succeed).
            if [ "$PROBE_REFUSED" -eq 1 ]; then :
            elif [ "$OPENWRT" -eq 1 ] && [ -d /etc/dropbear ] && pidof dropbear >/dev/null 2>&1; then SERVER_KIND=dropbear; SERVER_DESC="Dropbear $(dropbear -V 2>&1 | sed -n 's/.*v\([0-9.]*\).*/\1/p' | head -n 1)"
            elif pidof sshd >/dev/null 2>&1 || [ -d /etc/ssh ]; then SERVER_KIND=openssh; SERVER_DESC="OpenSSH (banner not read)"
            fi ;;
    esac
    [ -z "$SERVER_DESC" ] || note "ssh server: $SERVER_DESC on $SSH_HOST:$SSH_PORT"

    # This machine's SSH host keys: Telepy pins them (no trust-on-first-use later) and uses them to tell machines apart,
    # so a machine that already belongs to another account's tunnel is refused instead of taken over.
    # Candidates come from several sources; each one is accepted only after a strict handshake with exactly that key.
    CANDIDATES=""
    if [ "$IS_ROOT" -eq 1 ] && have dropbearkey; then
        for f in /etc/dropbear/dropbear_*_host_key; do
            [ -s "$f" ] || continue
            line=$(dropbearkey -y -f "$f" 2>/dev/null | grep '^ssh-\|^ecdsa-' | head -n 1 || true)
            [ -n "$line" ] && add_candidate "$(printf '%s' "$line" | awk '{print $1}')" "$(printf '%s' "$line" | awk '{print $2}')" "dropbearkey -y $f"
        done
    fi
    for f in /etc/ssh/ssh_host_*_key.pub; do
        [ -r "$f" ] || continue
        add_candidate "$(awk '{print $1}' "$f")" "$(awk '{print $2}' "$f")" "$f"
    done
    if have ssh-keyscan; then
        # No -T: on some OpenWrt builds a timeout makes ssh-keyscan give up at once (the same ppoll bug as below).
        # (Loop bodies end in `if`, never in a bare `[ ] && …`: under set -e a false test as the last command of a
        # pipeline's while loop would end the whole script silently.)
        scan=$(with_timeout 15 ssh-keyscan -p "$SSH_PORT" "$SSH_HOST" 2>/dev/null || true)
        printf '%s\n' "$scan" | while read -r h ty k rest; do
            if [ -n "$ty" ] && [ -n "$k" ]; then printf 'ssh-keyscan|%s %s|\n' "$ty" "$k"; fi
        done > "$TMP/scan"
        while IFS='|' read -r src pair rest; do
            if [ -n "$pair" ]; then add_candidate "${pair% *}" "${pair#* }" "$src"; fi
        done < "$TMP/scan"
    fi
    if [ -z "$CANDIDATES" ] && [ "$CLIENT" = openssh ]; then
        # Last resort: learn the key over loopback (the same trust as ssh-keyscan: nothing but root can sit between
        # this process and 127.0.0.1), then verify it strictly like the others.
        : > "$TMP/learn.known_hosts"
        with_timeout 20 "$SSH_BIN" -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$TMP/learn.known_hosts" \
            -o HostKeyAlias=telepy-local -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o LogLevel=ERROR \
            -p "$SSH_PORT" "telepy-probe@$SSH_HOST" true >/dev/null 2>&1 </dev/null || true
        while read -r h ty k rest; do if [ -n "$k" ]; then add_candidate "$ty" "$k" "learned over loopback"; fi; done < "$TMP/learn.known_hosts"
    fi
    HOST_KEYS_JSON=""
    HOST_KEY_SOURCE=""
    MISMATCHED=""
    NO_SERVER=0
    printf '%s' "$CANDIDATES" | while IFS='|' read -r src pair rest; do
        [ -n "$pair" ] || continue
        set -- $pair
        verify_host_key "$1" "$2" && rc=0 || rc=$?
        printf '%s|%s|%s\n' "$rc" "$src" "$pair"
    done > "$TMP/verified"
    while IFS='|' read -r rc src pair; do
        case "$rc" in
            0) HOST_KEYS_JSON="$HOST_KEYS_JSON${HOST_KEYS_JSON:+,}\"$pair\""; [ -n "$HOST_KEY_SOURCE" ] || HOST_KEY_SOURCE=$src
               note "host key ${pair%% *} from $src: verified by a strict handshake" ;;
            1) MISMATCHED="$MISMATCHED $src"; note "host key ${pair%% *} from $src: the server on $SSH_HOST:$SSH_PORT has a DIFFERENT key (ignored)" ;;
            2) NO_SERVER=1 ;;
            *) note "host key ${pair%% *} from $src: could not be verified (the handshake ended in an unexpected way)" ;;
        esac
    done < "$TMP/verified"
    if [ -z "$HOST_KEYS_JSON" ]; then
        say ""
        if [ "$NO_SERVER" -eq 1 ] || [ "$PROBE_REFUSED" -eq 1 ] || { [ -z "$CANDIDATES" ] && [ -r /proc/net/tcp ] && [ -z "$LISTEN_ADDRS" ]; }; then
            if [ "$OS" = Darwin ]; then
                die "no SSH server answers on $SSH_HOST:$SSH_PORT. Turn on Remote Login (System Settings > General > Sharing), or pass --ssh-port."
            fi
            die "no SSH server answers on $SSH_HOST:$SSH_PORT (checked by connecting, not by ssh-keyscan). Start one ($(pkg_hint sshd)), or pass --ssh-port / --ssh-host."
        fi
        if [ -z "$CANDIDATES" ]; then
            die "the SSH server on $SSH_HOST:$SSH_PORT answers, but its host key could not be read: no readable /etc/ssh/ssh_host_*_key.pub, no dropbearkey/-y as root (/etc/dropbear/*_host_key), and no ssh-keyscan. Run as root, or install openssh-client (ssh-keyscan)."
        fi
        die "none of the host keys found (${MISMATCHED:-none}) matched the server on $SSH_HOST:$SSH_PORT. Is another SSH server listening there? Pass --ssh-port / --ssh-host for the right one."
    fi
    say "ok ($SERVER_DESC)"

    # Where this SSH server reads this account's keys. Only resolved from the server, never guessed from "~/.ssh" alone.
    if [ -n "$AUTH_KEYS_OPT" ]; then
        AUTH_KEYS=$AUTH_KEYS_OPT
        AUTH_KEYS_WHY="--authorized-keys"
    elif [ "$SERVER_KIND" = dropbear ] && [ "$OPENWRT" -eq 1 ] && [ "$TARGET_UID" -eq 0 ]; then
        AUTH_KEYS=/etc/dropbear/authorized_keys
        AUTH_KEYS_WHY="OpenWrt's Dropbear reads root's keys from /etc/dropbear/authorized_keys"
    else
        AUTH_KEYS="$SSH_DIR/authorized_keys"
        AUTH_KEYS_WHY="$SERVER_KIND reads ~/.ssh/authorized_keys"
        if [ "$SERVER_KIND" = openssh ]; then
            akf=$( { sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || true; } | awk '$1 == "authorizedkeysfile" { print $2; exit }')
            if [ -n "$akf" ]; then
                akf=$(printf '%s' "$akf" | sed "s|%h|$TARGET_HOME|g; s|%u|$TARGET_USER|g; s|%%|%|g")
                case "$akf" in /*) ;; *) akf="$TARGET_HOME/$akf" ;; esac
                case "$akf" in *[!A-Za-z0-9._/-]*) ;; *) AUTH_KEYS=$akf; AUTH_KEYS_WHY="sshd -T AuthorizedKeysFile" ;; esac
            fi
        fi
    fi
    case "$AUTH_KEYS" in /*) ;; *) die "--authorized-keys must be an absolute path" ;; esac
    case "$AUTH_KEYS" in *[!A-Za-z0-9._/-]*) die "unsupported authorized_keys path: $AUTH_KEYS" ;; esac
    AUTH_DIR=$(dirname "$AUTH_KEYS")
    note "authorized_keys: $AUTH_KEYS ($AUTH_KEYS_WHY)"
    if [ "$IS_ROOT" -eq 0 ]; then
        if [ -e "$AUTH_KEYS" ] && [ ! -w "$AUTH_KEYS" ]; then die "cannot write $AUTH_KEYS as $CURRENT_USER (run with sudo)"; fi
        if [ ! -e "$AUTH_KEYS" ] && [ -d "$AUTH_DIR" ] && [ ! -w "$AUTH_DIR" ]; then die "cannot write in $AUTH_DIR as $CURRENT_USER (run with sudo)"; fi
    fi

    HOST_NAME=$( (hostname 2>/dev/null || uname -n) | tr -cd 'A-Za-z0-9._-')
    OS_INFO=$(uname -sm | tr -cd 'A-Za-z0-9._ -')

    # --- the gateway: reachable, host key pinned, keepalive probe (before any token is used) --------------------------
    step "Checking the Telepy gateway"
    http GET "$TELEPY_URL/api/join/gateway" || { http_hint; die "cannot reach $TELEPY_URL"; }
    [ "$HTTP_STATUS" = 200 ] || die "$(value ERROR || true) (HTTP $HTTP_STATUS)"
    GATEWAY_HOST=$(value GATEWAY_HOST)
    GATEWAY_PORT=$(value GATEWAY_PORT)
    GATEWAY_USER=$(value GATEWAY_USER)
    WS_URL=$(value WS_URL)
    GW_HOST_KEYS=$(values HOST_KEY)
    case "$GATEWAY_PORT" in ""|*[!0-9]*) die "unexpected answer from Telepy (gateway port)" ;; esac
    case "$GATEWAY_HOST$GATEWAY_USER" in ""|*[!A-Za-z0-9._-]*) die "unexpected answer from Telepy (gateway host)" ;; esac
    ALIAS="telepy-$GATEWAY_HOST-$GATEWAY_PORT"
    mkdir -p "$TMP/gw-home/.ssh"
    KNOWN_HOSTS_TMP="$TMP/gateway.known_hosts"
    : > "$KNOWN_HOSTS_TMP"
    STRICT=yes
    if [ -n "$GW_HOST_KEYS" ]; then
        printf '%s\n' "$GW_HOST_KEYS" | while IFS= read -r hk; do
            [ -n "$hk" ] || continue
            printf '%s %s\n' "$ALIAS" "$hk" >> "$KNOWN_HOSTS_TMP"
            printf '%s %s\n' "$GATEWAY_HOST" "$hk" >> "$TMP/gw-home/.ssh/known_hosts"
        done
        note "gateway: $GATEWAY_USER@$GATEWAY_HOST:$GATEWAY_PORT, $(printf '%s\n' "$GW_HOST_KEYS" | grep -c .) host key(s) pinned"
    else
        [ "$CLIENT" = openssh ] || die "Telepy sent no gateway host keys, and dbclient cannot pin on first use non-interactively (ask the admin to run ./telepy.sh keygen)"
        STRICT=accept-new
        "$SSH_BIN" -G -o StrictHostKeyChecking=accept-new localhost >/dev/null 2>&1 || STRICT=no
        warn "Telepy sent no gateway host keys (the server has none configured): the key is accepted on first use ($STRICT)"
    fi
    KNOWN_HOSTS=$KNOWN_HOSTS_TMP

    # --- SSH over WebSocket carrier (needed by the probe already) --------------------------------------------------
    PROXY_OPT=""
    PROXY_J=""
    if [ "$VIA_WEB" -eq 1 ]; then
        case "$WS_URL" in ws://*|wss://*) ;; *) die "Telepy sent no WebSocket address" ;; esac
        WS_PY="$TMP/telepy-ws.py"
        http_raw "$TELEPY_URL/api/join/telepy-ws.py" > "$WS_PY" || die "cannot download the WebSocket carrier"
        [ -s "$WS_PY" ] || die "cannot download the WebSocket carrier (empty)"
        WS_SH="$TMP/telepy-ws.sh"
        printf '#!/bin/sh\nexec %s %s %s\n' "$PYTHON" "$WS_PY" "$WS_URL" > "$WS_SH"
        chmod 700 "$WS_PY" "$WS_SH"
        PROXY_OPT="-o ProxyCommand=$WS_SH "
        PROXY_J="-J $WS_SH"
        note "transport: WebSocket on the web port ($WS_URL)"
    fi

    # Keepalive probe. Both runs are the same connection to the same gateway; only ServerAlive differs. On some
    # 32-bit OpenWrt builds (fortify-headers ppoll time_t bug, openwrt/openwrt #12574, e.g. ath79 GL-AR750S)
    # any ssh timeout misfires at once, so the key exchange "times out" immediately while a run without
    # ServerAlive completes. Then TCP keepalive is used instead (SSH-level heartbeats off, slower dead-link
    # detection; procd / systemd restart ssh only when it exits).
    KEEPALIVE_WHY=""
    COMPAT=""
    KEEPALIVE=""
    case "$CLIENT" in
        openssh)
            SA_OPTS="-o ServerAliveInterval=30 -o ServerAliveCountMax=3"
            if [ "$COMPAT_OPT" = force ]; then
                probe_gateway ""
                case "$GW_PROBE" in
                    ok) COMPAT=no_server_alive; KEEPALIVE=tcp; KEEPALIVE_WHY="--compat-no-server-alive given; the plain handshake works" ;;
                    hostkey) die "the gateway's host key does not match what Telepy announced: $(gw_last)" ;;
                    *) die "cannot complete an SSH handshake with $GATEWAY_HOST:$GATEWAY_PORT ($GW_PROBE): $(gw_last). Outbound TCP to that port must be allowed." ;;
                esac
            else
                probe_gateway "$SA_OPTS"
                r1=$GW_PROBE
                case "$r1" in
                    ok) KEEPALIVE=ssh; KEEPALIVE_WHY="handshake with ServerAliveInterval=30 completed" ;;
                    hostkey) die "the gateway's host key does not match what Telepy announced: $(gw_last)" ;;
                    unreachable) die "cannot connect to $GATEWAY_HOST:$GATEWAY_PORT: $(gw_last). Outbound TCP to that port must be allowed (or use --via-web)." ;;
                    *)
                        first_out=$(gw_last)
                        probe_gateway ""
                        case "$GW_PROBE" in
                            ok)
                                if [ "$COMPAT_OPT" = never ]; then
                                    die "the handshake times out as soon as ServerAliveInterval is set ($first_out), but works without it: this build's ssh timeouts misfire (OpenWrt #12574). Re-run with --compat-no-server-alive to use TCP keepalive instead."
                                fi
                                COMPAT=no_server_alive; KEEPALIVE=tcp
                                KEEPALIVE_WHY="with ServerAliveInterval=30 the key exchange timed out at once ($first_out); without it the handshake completed" ;;
                            hostkey) die "the gateway's host key does not match what Telepy announced: $(gw_last)" ;;
                            *) die "cannot complete an SSH handshake with $GATEWAY_HOST:$GATEWAY_PORT ($r1 / $GW_PROBE): $(gw_last). Outbound TCP to that port must be allowed (or use --via-web)." ;;
                        esac ;;
                esac
            fi ;;
        dbclient)
            probe_gateway ""
            case "$GW_PROBE" in
                ok) KEEPALIVE="ssh (-K 30)"; KEEPALIVE_WHY="handshake completed; dbclient keeps the link alive with -K 30" ;;
                hostkey) die "the gateway's host key does not match what Telepy announced: $(gw_last)" ;;
                closed) die "the gateway closed the connection during the key exchange ($(gw_last)). Telepy's gateway may be too old for this dbclient's key exchange; update Telepy, or install OpenSSH on this device and re-run with --client openssh." ;;
                *) die "cannot complete an SSH handshake with $GATEWAY_HOST:$GATEWAY_PORT ($GW_PROBE): $(gw_last). Outbound TCP to that port must be allowed." ;;
            esac
            [ "$COMPAT_OPT" = force ] && note "--compat-no-server-alive does not apply to dbclient (its -K keepalive is not affected)" ;;
    esac
    if [ -n "$COMPAT" ]; then
        warn "compat mode: SSH keepalives are OFF (ServerAliveInterval=0, TCPKeepAlive=yes). Why: $KEEPALIVE_WHY. A dead link is noticed later (TCP keepalive, often 2+ hours unless the kernel is tuned), and the service restarts ssh only when it exits."
    else
        note "keepalive: $KEEPALIVE ($KEEPALIVE_WHY)"
    fi

    if [ "$CHECK_ONLY" -eq 1 ]; then
        say ""
        say "Preflight passed. This machine would join with:"
        say "  shell            $SHELL_KIND"
        say "  http             $HTTP_TOOL"
        say "  ssh client       $CLIENT_DESC ($SSH_BIN)"
        say "  ssh server       ${SERVER_DESC:-unknown} on $SSH_HOST:$SSH_PORT, host key from $HOST_KEY_SOURCE"
        say "  authorized_keys  $AUTH_KEYS"
        say "  service          $SERVICE_DESC"
        say "  gateway          $GATEWAY_USER@$GATEWAY_HOST:$GATEWAY_PORT (host key pinned: $STRICT)"
        say "  keepalive        ${COMPAT:+TCP only (compat mode) — }$KEEPALIVE_WHY"
        say "No token was used. Create the join command in Telepy and run it the same way."
        exit 0
    fi

    # --- tunnel key ---------------------------------------------------------------------------------
    step "Preparing the tunnel key"
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    KEY_OPENSSH="$SSH_DIR/telepy_tunnel_ed25519"
    KEY_DROPBEAR="$SSH_DIR/telepy_tunnel_dropbear"
    KEY_FORMAT=openssh
    case "$CLIENT" in
        openssh)
            KEY=$KEY_OPENSSH
            if [ ! -f "$KEY" ] && [ -f "$KEY_DROPBEAR" ]; then
                if have dropbearconvert && dropbearconvert dropbear openssh "$KEY_DROPBEAR" "$KEY" >/dev/null 2>&1; then
                    say "converted the existing Dropbear-format key to OpenSSH format (same device, same tunnel)"
                else
                    warn "an earlier Dropbear-format key exists ($KEY_DROPBEAR) and cannot be converted (no dropbearconvert): a new key is created, which Telepy sees as a new device; delete the earlier tunnel in Telepy if it is not needed"
                fi
            fi
            if [ ! -f "$KEY" ]; then
                ssh-keygen -q -t ed25519 -N '' -C "telepy-tunnel@$HOST_NAME" -f "$KEY" </dev/null 2>/dev/null \
                    || ssh-keygen -q -t rsa -b 3072 -N '' -C "telepy-tunnel@$HOST_NAME" -f "$KEY" </dev/null \
                    || die "could not create $KEY"
                say "created $KEY"
            else
                say "using $KEY"
            fi
            [ -f "$KEY.pub" ] || ssh-keygen -y -f "$KEY" > "$KEY.pub"
            PUBLIC_KEY=$(tr -d '"\\\r\n' < "$KEY.pub") ;;
        dbclient)
            KEY=$KEY_DROPBEAR
            KEY_FORMAT=dropbear
            if [ ! -f "$KEY" ] && [ -f "$KEY_OPENSSH" ]; then
                if have dropbearconvert && dropbearconvert openssh dropbear "$KEY_OPENSSH" "$KEY" >/dev/null 2>&1; then
                    say "converted the existing OpenSSH-format key to Dropbear format (same device, same tunnel)"
                else
                    warn "an earlier OpenSSH-format key exists ($KEY_OPENSSH) and dbclient cannot read it (no dropbearconvert): a new key is created, which Telepy sees as a new device"
                fi
            fi
            if [ ! -f "$KEY" ]; then
                dropbearkey -t ed25519 -f "$KEY" >/dev/null 2>&1 || die "could not create $KEY (dropbearkey)"
                say "created $KEY (Dropbear format)"
            else
                say "using $KEY"
            fi
            PUBLIC_KEY=$(dropbearkey -y -f "$KEY" 2>/dev/null | grep '^ssh-' | head -n 1 | tr -d '"\\\r\n')
            [ -n "$PUBLIC_KEY" ] || die "dropbearkey -y could not read $KEY"
            printf '%s\n' "$PUBLIC_KEY" > "$KEY.pub" ;;
    esac
    chmod 600 "$KEY"

    # --- register -----------------------------------------------------------------------------------
    step "Registering this machine with Telepy"
    COMPAT_JSON=""
    [ -z "$COMPAT" ] || COMPAT_JSON="\"$COMPAT\""
    FACTS=$(printf '{"shell":"%s","os":"%s","arch":"%s","http":"%s","client":"%s","server":"%s","init":"%s","keepalive":"%s","key_format":"%s","authorized_keys":"%s","ssh_host":"%s","compat":[%s]}' \
        "$(jstr "$SHELL_KIND")" "$(jstr "$DISTRO")" "$(jstr "$ARCH")" "$(jstr "$HTTP_TOOL")" "$(jstr "$CLIENT_DESC")" "$(jstr "${SERVER_DESC:-unknown}")" \
        "$(jstr "$SERVICE")" "$(jstr "$KEEPALIVE")" "$KEY_FORMAT" "$(jstr "$AUTH_KEYS")" "$(jstr "$SSH_HOST:$SSH_PORT")" "$COMPAT_JSON")
    BODY=$(printf '{"public_key":"%s","hostname":"%s","username":"%s","ssh_port":%s,"os":"%s","name":"%s","host_keys":[%s],"facts":%s}' \
        "$PUBLIC_KEY" "$HOST_NAME" "$TARGET_USER" "$SSH_PORT" "$OS_INFO" "$NAME" "$HOST_KEYS_JSON" "$FACTS")
    if ! http POST "$TELEPY_URL/api/join/$TOKEN" "$BODY"; then
        # The request may have arrived and only the answer got lost: never register twice, ask what happened instead.
        http_hint
        say "the registration answer did not arrive; asking Telepy whether it got through"
        http GET "$TELEPY_URL/api/join/$TOKEN/status" || die "cannot reach $TELEPY_URL after the registration; run the same command again (the token is still valid if nothing was registered)"
        case "$(value PHASE)" in
            registered|connected|verified)
                http GET "$TELEPY_URL/api/join/$TOKEN/config" || die "the registration went through, but the configuration could not be fetched; run the same command again"
                [ "$HTTP_STATUS" = 200 ] || die "$(value ERROR || true) (HTTP $HTTP_STATUS)"
                say "recovered the registration (it had gone through)" ;;
            *) die "the registration did not go through (${HTTP_BODY:-no answer}); run the same command again" ;;
        esac
    else
        case "$HTTP_STATUS" in
            2*) ;;
            *) die "$(value ERROR || true) (HTTP $HTTP_STATUS)" ;;
        esac
    fi
    TUNNEL_ID=$(value TUNNEL_ID)
    TUNNEL_NAME=$(value TUNNEL_NAME)
    INSTALL_ID=$(value INSTALL_ID || true)
    REVERSE_PORT=$(value REVERSE_PORT)
    SERVICE_KEY=$(value SERVICE_KEY)
    WEB_URL=$(value WEB_URL)
    [ "$(value GATEWAY_HOST)" = "$GATEWAY_HOST" ] || die "unexpected answer from Telepy (the gateway host changed)"
    [ "$(value GATEWAY_PORT)" = "$GATEWAY_PORT" ] || die "unexpected answer from Telepy (the gateway port changed)"
    case "$TUNNEL_ID$REVERSE_PORT" in ""|*[!0-9]*) die "unexpected answer from Telepy" ;; esac
    case "$TUNNEL_NAME" in ""|*[!A-Za-z0-9._-]*) die "unexpected answer from Telepy" ;; esac
    case "$SERVICE_KEY" in ssh-*|ecdsa-*) ;; *) die "Telepy sent no service key" ;; esac
    case "$INSTALL_ID" in
        "") INSTALL_ID="tunnel-$TUNNEL_ID" ;;
        *[!a-z0-9]*) die "unexpected answer from Telepy" ;;
    esac
    say "registered as $TUNNEL_NAME (tunnel #$TUNNEL_ID, install id $INSTALL_ID)"
    SAME_MACHINE_AS=$(value SAME_MACHINE_AS || true)
    if [ -n "$SAME_MACHINE_AS" ]; then
        warn "this machine is already your tunnel '$SAME_MACHINE_AS' (same SSH host key). Two tunnels on one machine work, but they manage the same accounts and keys separately; consider adding this account to '$SAME_MACHINE_AS' instead."
    fi

    UNIT="telepy-$INSTALL_ID"
    UNINSTALL="$SSH_DIR/telepy-$INSTALL_ID-uninstall.sh"
    RECORD="$SSH_DIR/telepy-$INSTALL_ID.install"
    KNOWN_HOSTS="$SSH_DIR/telepy-$INSTALL_ID.known_hosts"
    cp "$KNOWN_HOSTS_TMP" "$KNOWN_HOSTS"
    chmod 600 "$KNOWN_HOSTS"

    # --- authorize Telepy ---------------------------------------------------------------------------
    step "Authorizing Telepy to log in as $TARGET_USER"
    mkdir -p "$AUTH_DIR"
    [ "$AUTH_DIR" = "$SSH_DIR" ] && chmod 700 "$AUTH_DIR"
    touch "$AUTH_KEYS"
    chmod 600 "$AUTH_KEYS"
    if grep -qxF "$SERVICE_KEY" "$AUTH_KEYS"; then
        say "the service key is already in $AUTH_KEYS"
    else
        if [ -s "$AUTH_KEYS" ] && [ -n "$(tail -c 1 "$AUTH_KEYS")" ]; then printf '\n' >> "$AUTH_KEYS"; fi
        printf '%s\n' "$SERVICE_KEY" >> "$AUTH_KEYS"
        say "added the service key to $AUTH_KEYS"
    fi

    # --- gateway host keys for the tunnel's own client -----------------------------------------------
    DB_KH=""
    DB_KH_LINES=""
    if [ "$CLIENT" = dbclient ]; then
        # dbclient reads only ~/.ssh/known_hosts of the account that runs it, matched by host name (no port, no alias).
        DB_KH="$TARGET_HOME/.ssh/known_hosts"
        mkdir -p "$TARGET_HOME/.ssh"; chmod 700 "$TARGET_HOME/.ssh"
        touch "$DB_KH"
        printf '%s\n' "$GW_HOST_KEYS" | while IFS= read -r hk; do
            [ -n "$hk" ] || continue
            ty=${hk%% *}
            have_line=$(grep -E "^$GATEWAY_HOST[ ,]" "$DB_KH" 2>/dev/null | awk -v t="$ty" '$2 == t' | head -n 1 || true)
            if [ -z "$have_line" ]; then
                printf '%s %s\n' "$GATEWAY_HOST" "$hk" >> "$DB_KH"
                printf '%s %s\n' "$GATEWAY_HOST" "$hk" >> "$TMP/db_kh_added"
            elif [ "$have_line" != "$GATEWAY_HOST $hk" ]; then
                printf '%s\n' "$ty" >> "$TMP/db_kh_conflict"
            fi
        done
        if [ -f "$TMP/db_kh_conflict" ]; then
            die "$DB_KH already has a different $(head -n 1 "$TMP/db_kh_conflict") key for $GATEWAY_HOST (dbclient matches host names only, not ports). Remove that line if it is stale, or install OpenSSH and re-run with --client openssh."
        fi
        # Lines an earlier run of this install added (listed in its record) stay ours, so the uninstall still removes them.
        if [ -f "$RECORD" ]; then
            sed -n 's/^KNOWN_HOSTS_LINE=//p' "$RECORD" | while IFS= read -r l; do
                if [ -n "$l" ] && grep -qxF -- "$l" "$DB_KH" 2>/dev/null; then printf '%s\n' "$l" >> "$TMP/db_kh_added"; fi
            done
        fi
        [ -f "$TMP/db_kh_added" ] && DB_KH_LINES=$(sort -u "$TMP/db_kh_added")
        say "pinned the gateway's host key in $DB_KH (for dbclient)"
    fi

    if [ "$IS_ROOT" -eq 1 ]; then
        chown "$TARGET_USER:$TARGET_GROUP" "$SSH_DIR" "$KEY" "$KEY.pub" "$KNOWN_HOSTS" 2>/dev/null || true
        case "$AUTH_KEYS" in "$TARGET_HOME"/*) chown "$TARGET_USER:$TARGET_GROUP" "$AUTH_KEYS" 2>/dev/null || true ;; esac
        [ -z "$DB_KH" ] || chown "$TARGET_USER:$TARGET_GROUP" "$DB_KH" "$TARGET_HOME/.ssh" 2>/dev/null || true
    fi

    # --- SSH over WebSocket: move the carrier next to the key ---------------------------------------------------
    if [ "$VIA_WEB" -eq 1 ]; then
        WS_PY_FINAL="$SSH_DIR/telepy-$INSTALL_ID-ws.py"
        WS_SH_FINAL="$SSH_DIR/telepy-$INSTALL_ID-ws.sh"
        cp "$WS_PY" "$WS_PY_FINAL"
        printf '#!/bin/sh\n# Telepy tunnel %s: carry ssh inside a WebSocket to the web port.\nexec %s %s %s\n' "$INSTALL_ID" "$PYTHON" "$WS_PY_FINAL" "$WS_URL" > "$WS_SH_FINAL"
        chmod 700 "$WS_PY_FINAL" "$WS_SH_FINAL"
        [ "$IS_ROOT" -eq 1 ] && chown "$TARGET_USER:$TARGET_GROUP" "$WS_PY_FINAL" "$WS_SH_FINAL"
        WS_PY=$WS_PY_FINAL; WS_SH=$WS_SH_FINAL
        PROXY_OPT="-o ProxyCommand=$WS_SH "
        PROXY_J="-J $WS_SH "
        say "the tunnel will connect through $WS_URL"
    fi

    case "$CLIENT" in
        openssh)
            if [ -n "$COMPAT" ]; then KEEP_OPTS="-o ServerAliveInterval=0 -o TCPKeepAlive=yes"; else KEEP_OPTS="-o ServerAliveInterval=30 -o ServerAliveCountMax=3"; fi
            SSH_ARGS="-NT -o ExitOnForwardFailure=yes $KEEP_OPTS -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=$STRICT -o UserKnownHostsFile=$KNOWN_HOSTS -o HostKeyAlias=$ALIAS ${PROXY_OPT}-i $KEY -p $GATEWAY_PORT -R 0:$SSH_HOST:$SSH_PORT $GATEWAY_USER@$GATEWAY_HOST" ;;
        dbclient)
            # -K: a keepalive every 30 s, the session ends after three unanswered. -I 0: no idle timeout. Host key: ~/.ssh/known_hosts (pinned above).
            SSH_ARGS="-N -T -K 30 -I 0 -o ExitOnForwardFailure=yes ${PROXY_J}-i $KEY -p $GATEWAY_PORT -R 0:$SSH_HOST:$SSH_PORT $GATEWAY_USER@$GATEWAY_HOST" ;;
    esac

    # --- run the tunnel -----------------------------------------------------------------------------
    FILES="$KEY $KEY.pub $KNOWN_HOSTS $RECORD $UNINSTALL"
    [ "$VIA_WEB" -eq 1 ] && FILES="$FILES $WS_PY $WS_SH"
    LOGS=""
    RUNNING=unknown; BOOT=unknown; SERVICE_KIND=""; SERVICE_NAME=""; SERVICE_FILE=""
    step "Starting the tunnel ($SERVICE_DESC)"
    remove_older_join
    case "$SERVICE" in
        procd) install_procd ;;
        systemd) if [ "$IS_ROOT" -eq 1 ]; then install_systemd_system; else install_systemd_user; fi ;;
        launchd) install_launchd ;;
        *) start_background ;;
    esac

    # --- the install record (no secrets) --------------------------------------------------------------------
    : > "$RECORD"
    record INSTALL_ID "$INSTALL_ID"
    record TUNNEL_ID "$TUNNEL_ID"
    record SERVER "$TELEPY_URL"
    record GATEWAY "$GATEWAY_USER@$GATEWAY_HOST:$GATEWAY_PORT"
    record INSTALLED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"
    record INSTALLER "$CURRENT_USER"
    record LOGIN_USER "$TARGET_USER"
    record RUN_USER "$TARGET_USER"
    record SHELL "$SHELL_KIND"
    record SYSTEM "$DISTRO ($OS $ARCH)"
    record HTTP "$HTTP_TOOL"
    record CLIENT "$CLIENT_DESC"
    record CLIENT_BIN "$SSH_BIN"
    record SSH_SERVER "${SERVER_DESC:-unknown}"
    record SSH_ENDPOINT "$SSH_HOST:$SSH_PORT"
    record HOST_KEY_SOURCE "$HOST_KEY_SOURCE"
    record AUTHORIZED_KEYS "$AUTH_KEYS"
    record KEY "$KEY"
    record KEY_FORMAT "$KEY_FORMAT"
    record KNOWN_HOSTS "$KNOWN_HOSTS"
    [ -z "$DB_KH" ] || record DBCLIENT_KNOWN_HOSTS "$DB_KH"
    [ -z "$DB_KH_LINES" ] || printf '%s\n' "$DB_KH_LINES" | while IFS= read -r l; do if [ -n "$l" ]; then record KNOWN_HOSTS_LINE "$l"; fi; done
    record SERVICE "$SERVICE_KIND"
    record SERVICE_NAME "$SERVICE_NAME"
    record SERVICE_FILE "$SERVICE_FILE"
    record KEEPALIVE "$KEEPALIVE"
    [ -z "$COMPAT" ] || record COMPAT "$COMPAT"
    record TRANSPORT "$([ "$VIA_WEB" -eq 1 ] && printf websocket || printf ssh)"
    record UNINSTALL "$UNINSTALL"
    record FILES "$FILES"
    chmod 600 "$RECORD"
    [ "$IS_ROOT" -eq 1 ] && chown "$TARGET_USER:$TARGET_GROUP" "$RECORD" 2>/dev/null || true

    # --- self-test ----------------------------------------------------------------------------------
    # Counted in loop turns (2 s each), not in wall-clock time: a router that sets its clock from NTP meanwhile
    # must not make this wait forever or give up at once.
    step "Waiting for Telepy to log in through the tunnel"
    PHASE=""
    DETAIL=""
    CONNECTED=no
    i=0
    bad=0
    while [ "$i" -lt 60 ]; do
        if http GET "$TELEPY_URL/api/join/$TOKEN/status" && [ "$HTTP_STATUS" = 200 ]; then
            PHASE=$(value PHASE)
            DETAIL=$(value DETAIL)
            case "$PHASE" in
                waiting|registered) ;;
                connected) [ "$CONNECTED" = yes ] || say "tunnel connected (reverse port $REVERSE_PORT); Telepy is checking the login"; CONNECTED=yes ;;
                verified) CONNECTED=yes; break ;;
                failed) CONNECTED=yes; break ;;
                *) bad=$((bad + 1)) ;;
            esac
        else
            bad=$((bad + 1))
            [ "$bad" -ne 5 ] || warn "Telepy's answers are not what this script expects ($(printf '%s' "${HTTP_ERR:-$HTTP_BODY}" | head -c 100)); still waiting"
        fi
        sleep 2
        i=$((i + 1))
        [ $((i % 10)) -ne 0 ] || say "  still waiting ($((i * 2)) s, phase: ${PHASE:-?})"
    done

    say ""
    say "Files: $FILES"
    say "Record: $RECORD"
    say "Uninstall: sh $UNINSTALL"
    [ -n "$LOGS" ] && say "Logs: $LOGS"
    say ""
    say "State:"
    say "  files installed        yes"
    case "$BOOT" in
        yes) say "  starts at boot         yes ($SERVICE_KIND: $SERVICE_NAME)" ;;
        login) say "  starts at boot         while $CURRENT_USER is logged in only ($SERVICE_KIND)" ;;
        no) say "  starts at boot         NO ($SERVICE_DESC)" ;;
        *) say "  starts at boot         unknown" ;;
    esac
    case "$RUNNING" in
        yes) say "  process running        yes" ;;
        no) say "  process running        NO (see the logs)" ;;
        *) say "  process running        unknown" ;;
    esac
    case "$PHASE" in
        connected|verified|failed) say "  tunnel connected       yes" ;;
        *) say "  tunnel connected       NO (nothing reached the gateway yet)" ;;
    esac
    case "$PHASE" in
        verified) say "  login verified         yes (Telepy logged in as $TARGET_USER)" ;;
        failed) say "  login verified         NO: $DETAIL" ;;
        *) say "  login verified         not yet" ;;
    esac
    [ -z "$COMPAT" ] || say "  keepalive              TCP only (compat mode: $COMPAT)"
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
        connected)
            say ""
            die "the tunnel is up, but Telepy has not finished checking the login (${DETAIL:-still checking}). Check the device in Telepy: $WEB_URL"
            ;;
        *)
            say ""
            die "the tunnel did not come up within 120 seconds. Check the logs above ($LOGS); outbound TCP to $GATEWAY_HOST:$GATEWAY_PORT must be allowed. The service keeps retrying every 10 s, and Telepy will show the device once it connects."
            ;;
    esac
}

main "$@"
