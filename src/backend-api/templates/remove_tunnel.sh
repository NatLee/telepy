# telepy-remove-tunnel: run by Telepy over SSH when a tunnel is deleted (Linux / macOS / other POSIX).
# Phase 1 (this script): find everything that runs THIS tunnel (matched by its key — the -i file of a
# command, the key next to a unit or compose file — or, for older scripts, its reverse port; tunnel id
# and name for the one-command install; nothing else is touched), remove its files right away and write
# the stopping part into a one-shot stop script. Telepy starts the stop script last, because stopping the tunnel also cuts the
# SSH session this runs in. Every result is a line "TELEPY|<kind>|<what>|<detail>".
T_ID=${t_id}
T_PORT=${t_port}
T_NAME=${t_name}
T_KEY=${t_key}

out() { printf 'TELEPY|%s|%s|%s\n' "$1" "$2" "$3"; }
# The forward as files write it (a unit, a plist line, a script): older scripts carry the number.
PORT_RE="(^|[^0-9])$T_PORT:(localhost|127\.0\.0\.1|\[::1\]|::1):[0-9]+"
# A -R forward in a process or crontab line (never a -L with the same number).
PROC_RE="-[A-Za-z]*R ?['\"]?([^ :'\"]*:)?$T_PORT:(localhost|127\.0\.0\.1|\[::1\]|::1):[0-9]+"
# Any -R forward at all (new scripts ask for 0, so the number cannot tell; the key does).
ANY_R_RE="-[A-Za-z]*R ?['\"]?([^ :'\"]*:)?[0-9]+:"

# Expand a leading ~ or $HOME.
expand_path() {
    case "$1" in
        "~") printf '%s' "$HOME" ;;
        "~/"*) printf '%s%s' "$HOME" "${1#\~}" ;;
        '$HOME'|'$HOME/'*) printf '%s%s' "$HOME" "${1#\$HOME}" ;;
        '${HOME}'*) printf '%s%s' "$HOME" "${1#\$\{HOME\}}" ;;
        *) printf '%s' "$1" ;;
    esac
}
# Is this private key the tunnel's: the .pub next to it first, else ssh-keygen derives the public key.
# (No locals in sh: names here must not clash with callers' loop variables.)
key_matches() {
    km_file=$(expand_path "$1")
    [ -f "$km_file" ] || return 1
    if [ -r "$km_file.pub" ] && awk '{print $2}' "$km_file.pub" 2>/dev/null | grep -qxF -- "$T_KEY"; then return 0; fi
    command -v ssh-keygen >/dev/null 2>&1 && ssh-keygen -y -f "$km_file" 2>/dev/null | awk '{print $2}' | grep -qxF -- "$T_KEY"
}
# Key files a text (file contents or a command line) refers to: -i <path>, IdentityFile,
# docker's KEY_FILE= and <path>:/id_rsa.
key_paths() {
    printf '%s\n' "$1" | grep -oE -- "-i ?['\"]?[^ '\"]+" | sed -E "s/^-i ?['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "IdentityFile[ =]['\"]?[^ '\"]+" | sed -E "s/^IdentityFile[ =]['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "KEY_FILE=['\"]?[^ '\"]+" | sed -E "s/^KEY_FILE=['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "[^\"' ]+:/id_rsa" | sed 's#:/id_rsa$##'
}
# Does this text use the tunnel's key?
uses_key() {
    for uk_path in $(key_paths "$1"); do key_matches "$uk_path" && return 0; done
    return 1
}
# A file of this tunnel: it carries its number (older scripts) or refers to its key.
has_port() {
    [ -f "$1" ] || return 1
    grep -Eq -- "$PORT_RE|SSH_TUNNEL_PORT[=:][\" ]*$T_PORT([^0-9]|$)" "$1" 2>/dev/null && return 0
    uses_key "$(cat "$1" 2>/dev/null)"
}
# A command line of this tunnel: -R with its number, or any -R plus its key (never a -L only client).
line_is_mine() {
    printf '%s' "$1" | grep -Eq -- "$PROC_RE" && return 0
    printf '%s' "$1" | grep -Eq -- "$ANY_R_RE" || return 1
    uses_key "$1"
}

OS=$(uname -s 2>/dev/null || echo unknown)
ME=$(id -un 2>/dev/null || echo "?")
MY_UID=$(id -u 2>/dev/null || echo 1)
SUDO=""
ROOT=0
if [ "$MY_UID" = 0 ]; then
    ROOT=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
    ROOT=1
fi
out platform "$OS" "$ME root=$ROOT"
if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then
    out failed home "no home directory for $ME"
    exit 0
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$MY_UID}"

STOP=$(mktemp "${TMPDIR:-/tmp}/telepy-stop-$T_ID.XXXXXX" 2>/dev/null) || STOP="$HOME/.telepy-stop-$T_ID.sh"
if ! printf '#!/bin/sh\n# telepy-remove-tunnel stop script for tunnel #%s (deletes itself)\nsleep 2\n' "$T_ID" > "$STOP"; then
    out failed stopscript "$STOP"
    exit 0
fi
chmod 700 "$STOP"
STOPS=0
LATE=""
# Stopping steps go into the stop script; logs are deleted last, once their writers have stopped (LATE).
later() { printf '%s\n' "$1" >> "$STOP"; STOPS=$((STOPS + 1)); out scheduled "$2" "$3"; }
latelog() { LATE="$LATE$1
"; STOPS=$((STOPS + 1)); out scheduled log "$2"; }
# Files the stop script deletes (left out when checking whether anything still uses known_hosts).
GOING=" "
FOUND_JOIN=0

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Delete; fall back to sudo; else report that root is needed.
rmf() {
    [ -e "$1" ] || [ -L "$1" ] || return 0
    rm -f "$1" 2>/dev/null
    if { [ -e "$1" ] || [ -L "$1" ]; } && [ -n "$SUDO" ]; then $SUDO rm -f "$1" 2>/dev/null; fi
    if [ -e "$1" ] || [ -L "$1" ]; then out needs_root "$2" "sudo rm -f $1"; else out removed "$2" "$1"; fi
}

# --- systemd (system units: join as root, the autossh service script, units written by hand) ---------
if command -v systemctl >/dev/null 2>&1; then
    for f in /etc/systemd/system/*.service /lib/systemd/system/telepy*.service /usr/lib/systemd/system/telepy*.service; do
        has_port "$f" || continue
        name=$(basename "$f")
        out found systemd "$name"
        [ "$name" = "telepy-tunnel-$T_ID.service" ] && FOUND_JOIN=1
        if [ "$ROOT" = 1 ]; then
            logdir=$(sed -n 's/^LogsDirectory=//p' "$f" 2>/dev/null | head -n 1)
            logfiles=$(sed -n 's/.*AUTOSSH_LOGFILE=\([^" ]*\).*/\1/p' "$f" 2>/dev/null)
            $SUDO systemctl disable "$name" >/dev/null 2>&1
            rmf "$f" unit
            for w in /etc/systemd/system/*.wants/"$name"; do
                if [ -L "$w" ]; then rmf "$w" unit; fi
            done
            later "$SUDO systemctl stop $(q "$name") >/dev/null 2>&1; $SUDO systemctl daemon-reload >/dev/null 2>&1; $SUDO systemctl reset-failed $(q "$name") >/dev/null 2>&1" stop "systemd $name"
            case "$logdir" in
                telepy*) latelog "$SUDO rm -rf $(q "/var/log/$logdir")" "/var/log/$logdir" ;;
            esac
            for lf in $logfiles; do
                case "$lf" in */telepy*) latelog "$SUDO rm -f $(q "$lf")" "$lf" ;; esac
            done
        else
            out needs_root systemd "sudo systemctl disable --now $name && sudo rm -f $f && sudo systemctl daemon-reload"
        fi
        out note journal "journald keeps the old log lines of $name until it rotates them"
    done
    # systemd --user units (join without sudo).
    for f in "$HOME"/.config/systemd/user/*.service; do
        has_port "$f" || continue
        name=$(basename "$f")
        out found systemd-user "$name"
        [ "$name" = "telepy-tunnel-$T_ID.service" ] && FOUND_JOIN=1
        systemctl --user disable "$name" >/dev/null 2>&1
        rmf "$f" unit
        for w in "$HOME"/.config/systemd/user/*.wants/"$name"; do
            if [ -L "$w" ]; then rmf "$w" unit; fi
        done
        later "systemctl --user stop $(q "$name") >/dev/null 2>&1; systemctl --user daemon-reload >/dev/null 2>&1; systemctl --user reset-failed $(q "$name") >/dev/null 2>&1" stop "systemd --user $name"
    done
fi

# --- launchd (macOS: join as LaunchDaemon / LaunchAgent) ---------------------------------------------
if command -v launchctl >/dev/null 2>&1; then
    for f in /Library/LaunchDaemons/*.plist "$HOME"/Library/LaunchAgents/*.plist; do
        has_port "$f" || continue
        label=$(basename "$f" .plist)
        out found launchd "$label"
        [ "$label" = "com.telepy.tunnel.$T_ID" ] && FOUND_JOIN=1
        case "$f" in
            /Library/*)
                if [ "$ROOT" = 0 ]; then
                    out needs_root launchd "sudo launchctl bootout system/$label; sudo rm -f $f"
                    continue
                fi
                later "$SUDO launchctl bootout system/$(q "$label") >/dev/null 2>&1 || $SUDO launchctl unload -w $(q "$f") >/dev/null 2>&1" stop "launchd $label"
                later "$SUDO rm -f $(q "$f")" file "$f" ;;
            *)
                later "launchctl bootout gui/$MY_UID/$(q "$label") >/dev/null 2>&1 || launchctl bootout user/$MY_UID/$(q "$label") >/dev/null 2>&1 || launchctl unload -w $(q "$f") >/dev/null 2>&1" stop "launchd $label"
                later "rm -f $(q "$f")" file "$f" ;;
        esac
        GOING="$GOING$f "
        for lf in $(sed -n 's:.*<string>\(/[^<]*telepy[^<]*\.log\)</string>.*:\1:p' "$f" 2>/dev/null); do
            latelog "$SUDO rm -f $(q "$lf")" "$lf"
            GOING="$GOING$lf "
        done
    done
fi

# --- processes running this tunnel, and the scripts that started them ---------------------------------
# (Background loops, ssh / autossh template scripts run by hand.)
RUNNERS=""
if has_port "$HOME/.ssh/telepy-tunnel-$T_ID.sh"; then
    RUNNERS=" $HOME/.ssh/telepy-tunnel-$T_ID.sh"
    FOUND_JOIN=1
fi
PIDS=""
pinfo() {
    if [ -r "/proc/$1/cmdline" ]; then tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null
    else ps -o args= -p "$1" 2>/dev/null; fi
}
uid_of() {
    if [ -r "/proc/$1/status" ]; then awk '/^Uid:/ { print $2; exit }' "/proc/$1/status" 2>/dev/null
    else ps -o uid= -p "$1" 2>/dev/null | tr -d ' '; fi
}
# Someone else's process: without root / sudo we cannot kill it, so report it as it is.
check_owner() {
    owner=$(uid_of "$1")
    if [ -n "$owner" ] && [ "$owner" != "$MY_UID" ] && [ "$ROOT" = 0 ]; then out needs_root process "sudo kill $1"; fi
}
ppid_of() {
    if [ -r "/proc/$1/stat" ]; then sed 's/^.*) [A-Za-z] \([0-9]*\).*/\1/' "/proc/$1/stat" 2>/dev/null
    else ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; fi
}
if [ -r /proc/1/cmdline ]; then
    ALL=$(for d in /proc/[0-9]*; do printf '%s %s\n' "${d#/proc/}" "$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null)"; done)
else
    ALL=$(ps -A -o pid= -o args= 2>/dev/null)
fi
MATCHED=$(printf '%s\n' "$ALL" | grep -E -- "$ANY_R_RE" | grep -E 'ssh' | grep -v 'telepy-remove-tunnel' | grep -v 'telepy-stop-' | while IFS= read -r l; do line_is_mine "$l" && printf '%s\n' "$l"; done)
while IFS= read -r line; do
    pid=$(printf '%s' "$line" | awk '{print $1}')
    case "$pid" in ""|*[!0-9]*) continue ;; esac
    out found process "$line"
    check_owner "$pid"
    PIDS="$PIDS $pid"
    pp=$(ppid_of "$pid")
    hops=0
    while [ -n "$pp" ] && [ "$pp" != 1 ] && [ "$pp" != 0 ] && [ "$hops" -lt 3 ]; do
        script=$(pinfo "$pp" | awk '{ for (i = 2; i <= NF; i++) if ($i ~ /^\// || $i ~ /\.(sh|bash)$/) { print $i; exit } }')
        case "$script" in
            "") ;;
            /*) ;;
            *) [ -d "/proc/$pp/cwd" ] && script="$(readlink "/proc/$pp/cwd" 2>/dev/null)/$script" ;;
        esac
        if [ -n "$script" ] && has_port "$script"; then
            check_owner "$pp"
            PIDS="$pp$PIDS"
            PIDS=" $PIDS"
            case "$RUNNERS " in *" $script "*) ;; *) RUNNERS="$RUNNERS $script" ;; esac
        fi
        pp=$(ppid_of "$pp")
        hops=$((hops + 1))
    done
done <<EOF
$MATCHED
EOF

# Crontab lines pointing at the runners or carrying the forward.
crontab_clean() {
    CR=$($1 crontab -l 2>/dev/null) || return 0
    KEEP=$(printf '%s\n' "$CR" | while IFS= read -r l; do line_is_mine "$l" || printf '%s\n' "$l"; done)
    for r in $RUNNERS; do KEEP=$(printf '%s\n' "$KEEP" | grep -vF -- "$r"); done
    [ "$KEEP" = "$CR" ] && return 0
    printf '%s\n' "$CR" | grep -v -x -F -- "$KEEP" | while IFS= read -r l; do [ -n "$l" ] && out found cron "$l"; done
    if [ -z "$KEEP" ]; then printf '' | $1 crontab - 2>/dev/null; else printf '%s\n' "$KEEP" | $1 crontab - 2>/dev/null; fi
    if [ "$?" = 0 ]; then out removed cron "crontab of $2"; else out failed cron "could not rewrite the crontab of $2"; fi
}
if command -v crontab >/dev/null 2>&1; then
    crontab_clean "" "$ME"
    [ -n "$SUDO" ] && crontab_clean "$SUDO" root
fi
for r in $RUNNERS; do
    out found loop "$r"
    rmf "$r" file
    log="${r%.sh}.log"
    if [ -f "$log" ]; then
        latelog "rm -f $(q "$log")" "$log"
        GOING="$GOING$log "
    fi
done

# Downloaded scripts of this tunnel that are not running (ssh / autossh / docker templates).
for f in "$HOME"/*.sh "$HOME"/*.yml "$HOME"/*.yaml "$HOME"/Downloads/*.sh "$HOME"/Downloads/*.yml "$HOME"/Desktop/*.sh; do
    has_port "$f" || continue
    out found script "$f"
    rmf "$f" file
done

# --- Docker (docker run / docker compose templates: jnovack/autossh with SSH_TUNNEL_PORT) -----------
DOCKER=""
if command -v docker >/dev/null 2>&1; then
    if docker ps -q >/dev/null 2>&1; then DOCKER="docker"
    elif [ -n "$SUDO" ] && $SUDO docker ps -q >/dev/null 2>&1; then DOCKER="$SUDO docker"; fi
    [ -z "$DOCKER" ] && out note docker "could not list containers as $ME (not in the docker group); a telepy-tunnel container, if any, is left running"
fi
if [ -n "$DOCKER" ]; then
    for c in $($DOCKER ps -aq 2>/dev/null); do
        # Old containers carry the number in the env; new ones mount the tunnel's key at /id_rsa.
        if ! $DOCKER inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | grep -Eq "^SSH_TUNNEL_PORT=$T_PORT$"; then
            mounted=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/id_rsa"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null)
            [ -n "$mounted" ] && key_matches "$mounted" || continue
        fi
        cname=$($DOCKER inspect -f '{{.Name}}' "$c" 2>/dev/null | sed 's:^/::')
        out found docker "$cname"
        later "$DOCKER rm -f $c >/dev/null 2>&1" stop "docker $cname"
        compose=$($DOCKER inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c" 2>/dev/null)
        for cf in $(printf '%s' "$compose" | tr ',' ' '); do
            if has_port "$cf"; then rmf "$cf" file; fi
        done
        latelog "$DOCKER image rm jnovack/autossh:latest >/dev/null 2>&1 || true" "image jnovack/autossh (only if no other container uses it)"
    done
fi

# --- stop the processes last: runner loops before ssh (else the loop starts it again) ----------------
if [ -n "$PIDS" ]; then
    later "kill$PIDS >/dev/null 2>&1 || $SUDO kill$PIDS >/dev/null 2>&1; sleep 1; kill -9$PIDS >/dev/null 2>&1; $SUDO kill -9$PIDS >/dev/null 2>&1" stop "processes$PIDS"
fi

# --- files of the one-command install ------------------------------------------------------------------
SSH_DIR="$HOME/.ssh"
for k in "$SSH_DIR"/telepy_tunnel_*; do
    case "$k" in *.pub) continue ;; esac
    [ -f "$k.pub" ] || continue
    if awk '{print $2}' "$k.pub" 2>/dev/null | grep -qxF -- "$T_KEY"; then
        rmf "$k" key
        rmf "$k.pub" key
    else
        out kept key "$k (another tunnel's key)"
    fi
done
U="$SSH_DIR/telepy-uninstall-$T_ID.sh"
if [ -f "$U" ] && grep -qF "(#$T_ID)" "$U" 2>/dev/null; then
    if [ "$FOUND_JOIN" = 1 ] || grep -qF "tunnel $T_NAME (#$T_ID)" "$U" 2>/dev/null; then
        out found join "$U"
        rmf "$U" file
    fi
fi
# The SSH-over-WebSocket carrier (used by this tunnel only).
for f in "$SSH_DIR/telepy-ws-$T_ID.py" "$SSH_DIR/telepy-ws-$T_ID.sh"; do
    [ -f "$f" ] && rmf "$f" file
done
KH="$SSH_DIR/telepy_known_hosts"
if [ -f "$KH" ]; then
    USERS=""
    for f in /etc/systemd/system/*.service "$HOME"/.config/systemd/user/*.service /Library/LaunchDaemons/*.plist "$HOME"/Library/LaunchAgents/*.plist "$SSH_DIR"/telepy-tunnel-*.sh; do
        [ -f "$f" ] || continue
        case "$GOING" in *" $f "*) continue ;; esac
        grep -qF "$KH" "$f" 2>/dev/null && USERS="$USERS $f"
    done
    if [ -n "$USERS" ]; then out kept file "$KH (still used by$USERS)"; else rmf "$KH" file; fi
fi

if [ "$STOPS" -gt 0 ]; then
    printf '%s' "$LATE" >> "$STOP"
    printf 'rm -f "$0"\n' >> "$STOP"
    out stopscript sh "$STOP"
else
    rm -f "$STOP"
fi
out done "$OS" "$ME"
