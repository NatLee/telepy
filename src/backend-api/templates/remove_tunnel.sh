# telepy-remove-tunnel: run by Telepy over SSH when a tunnel is deleted (Linux / macOS / other POSIX).
# Phase 1 (this script): find everything that runs THIS tunnel (matched by its key — the -i file of a
# command, the key next to a unit or compose file — or, for older scripts, its reverse port; tunnel id
# and name for the one-command install; nothing else is touched), remove its files right away and write
# the stopping part into a one-shot stop script. Telepy starts the stop script last, because stopping the tunnel also cuts the
# SSH session this runs in. Every result is a line "TELEPY|<kind>|<what>|<detail>".
# Modes: delete (the above), survey (only report what is there: nothing is changed), relabel (the tunnel's service got
# new names: remove the older ones, keep the key and everything named after the install id).
# Anything that dials another server (its -p / Port / SSH_REMOTE_PORT is not this gateway's) is never touched.
T_ID=${t_id}
T_PORT=${t_port}
T_NAME=${t_name}
T_KEY=${t_key}
T_MODE=${t_mode}
T_INSTALL=${t_install}
T_GW_PORT=${t_gw_port}
# The install id a switch replaced (relabel only): its leftover files go, named after it.
T_OLD_INSTALL=${t_old_install}
SURVEY=0
[ "$T_MODE" = survey ] && SURVEY=1
KEEP_ID=""
[ "$T_MODE" = relabel ] && KEEP_ID=$T_INSTALL
# Things of another server that use this tunnel's key (the same device key on two Telepy servers): the key stays then.
KEY_ELSEWHERE=""

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
# Files the login account cannot read (a root-run unit's key in /root, another account's loop) are read with
# sudo -n when the account has it; nothing is ever changed this way.
rd() { cat "$1" 2>/dev/null || { [ -n "$SUDO" ] && $SUDO cat "$1" 2>/dev/null; }; }
exists() { [ -f "$1" ] || { [ -n "$SUDO" ] && $SUDO test -f "$1" 2>/dev/null; }; }
km_check() {
    exists "$1" || return 1
    if rd "$1.pub" | awk '{print $2}' | grep -qxF -- "$T_KEY"; then return 0; fi
    command -v ssh-keygen >/dev/null 2>&1 || return 1
    ssh-keygen -y -P '' -f "$1" 2>/dev/null | awk '{print $2}' | grep -qxF -- "$T_KEY" && return 0
    [ -n "$SUDO" ] && $SUDO ssh-keygen -y -P '' -f "$1" 2>/dev/null | awk '{print $2}' | grep -qxF -- "$T_KEY"
}
# Answers are remembered per path (so sudo is asked once per key file, not once per line).
KM_YES=" "
KM_NO=" "
key_matches() {
    km_file=$(expand_path "$1")
    case "$KM_YES" in *" $km_file "*) return 0 ;; esac
    case "$KM_NO" in *" $km_file "*) return 1 ;; esac
    if km_check "$km_file"; then KM_YES="$KM_YES$km_file "; return 0; fi
    KM_NO="$KM_NO$km_file "
    return 1
}
# Key files a text (file contents or a command line) refers to: -i <path> (also quoted word by word: '-i' '/k'),
# IdentityFile, docker's KEY_FILE= and <path>:/id_rsa.
key_paths() {
    printf '%s\n' "$1" | grep -oE -- "-i['\"]? ?['\"]?[^ '\"]+" | sed -E "s/^-i['\"]? ?['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "IdentityFile[ =]['\"]?[^ '\"]+" | sed -E "s/^IdentityFile[ =]['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "KEY_FILE=['\"]?[^ '\"]+" | sed -E "s/^KEY_FILE=['\"]?//"
    printf '%s\n' "$1" | grep -oE -- "[^\"' ]+:/id_rsa" | sed 's#:/id_rsa$##'
}
# Does this text use the tunnel's key?
uses_key() {
    for uk_path in $(key_paths "$1"); do key_matches "$uk_path" && return 0; done
    return 1
}
# The new service of a rename (named after the install id): never touched in relabel mode.
kept_new() {
    [ -n "$KEEP_ID" ] || return 1
    case "$1" in *"telepy-$KEEP_ID"*|*"tunnel.$KEEP_ID"*) return 0 ;; esac
    return 1
}
# Ports a text dials: -p N (also -pN and '-p' 'N'), Port=N, SSH_REMOTE_PORT=N. Nothing = it does not say.
dial_ports() {
    printf '%s\n' "$1" | grep -oE -- "(^|[ '\"=])-p['\"]? ?['\"]?[0-9]+" | grep -oE '[0-9]+$'
    printf '%s\n' "$1" | grep -oE -- "(Port[= ]['\"]?|SSH_REMOTE_PORT[=:] ?['\"]?)[0-9]+" | grep -oE '[0-9]+$'
}
# Goes to another server: it names a port and none is this gateway's (the same key may serve two Telepy servers).
foreign() {
    [ -n "$T_GW_PORT" ] || return 1
    fp_list=$(dial_ports "$1")
    [ -n "$fp_list" ] || return 1
    printf '%s\n' "$fp_list" | grep -qx -- "$T_GW_PORT" && return 1
    return 0
}
# A command that names no key file uses its account's default keys (what ssh tries on its own). It is this tunnel's
# when it dials this very gateway (its port is named) with a -R forward and one of those defaults is the tunnel key.
DEFAULT_KEYS="id_ed25519 id_ecdsa id_rsa id_ed25519_sk id_ecdsa_sk id_dsa"
home_of() {
    case "$1" in ""|*[!A-Za-z0-9._-]*) return 0 ;; esac
    eval "printf '%s' ~$1" 2>/dev/null
}
dials_here_with_forward() {
    [ -n "$T_GW_PORT" ] || return 1
    dial_ports "$1" | grep -qx -- "$T_GW_PORT" || return 1
    printf '%s\n' "$1" | grep -Eq -- "-[A-Za-z]*R['\"]? ?['\"]?([^ :'\"]*:)?[0-9]+:"
}
default_key_of() {
    [ -n "$2" ] || return 1
    [ -n "$(key_paths "$1")" ] && return 1
    dials_here_with_forward "$1" || return 1
    for dk in $DEFAULT_KEYS; do key_matches "$2/.ssh/$dk" && return 0; done
    return 1
}
# Whose default keys a unit / plist / script would use: User= / UserName, root for system ones, else this account.
file_home() {
    fh_user=$(printf '%s\n' "$2" | sed -n 's/^User=//p' | head -n 1)
    [ -n "$fh_user" ] || fh_user=$(printf '%s' "$2" | tr -d '\n' | sed -n 's:.*<key>UserName</key>[[:space:]]*<string>\([^<]*\)</string>.*:\1:p')
    case "$1" in /etc/systemd/*|/lib/systemd/*|/usr/lib/systemd/*|/Library/LaunchDaemons/*) [ -n "$fh_user" ] || fh_user=root ;; esac
    if [ -n "$fh_user" ]; then home_of "$fh_user"; else printf '%s' "$HOME"; fi
}
# A file's text as a command line: a launchd plist puts every argument in its own <string>, so join them with spaces.
text_of() {
    case "$1" in
        *.plist) rd "$1" | tr '\n' ' ' | sed -e 's:</string>[[:space:]]*<string>: :g' -e 's:<[^>]*>: :g' ;;
        *) rd "$1" ;;
    esac
}
# A file of this tunnel: it carries its number (older scripts) or refers to its key, and dials this server.
has_port() {
    exists "$1" || return 1
    kept_new "$1" && return 1
    hp_text=$(text_of "$1")
    if printf '%s\n' "$hp_text" | grep -Eq -- "$PORT_RE|SSH_TUNNEL_PORT[=:][\" ]*$T_PORT([^0-9]|$)" || uses_key "$hp_text" || default_key_of "$hp_text" "$(file_home "$1" "$(rd "$1")")"; then
        if foreign "$hp_text"; then
            out kept other-server "$1 (port $(dial_ports "$hp_text" | head -n 1))"
            uses_key "$hp_text" && KEY_ELSEWHERE="$KEY_ELSEWHERE $1"
            return 1
        fi
        return 0
    fi
    return 1
}
# A command line of this tunnel: -R with its number, or any -R plus its key (never a -L only client).
# A process line starts with its pid (its owner's default keys count); a crontab line belongs to this account.
line_is_mine() {
    kept_new "$1" && return 1
    foreign "$1" && return 1
    printf '%s' "$1" | grep -Eq -- "$PROC_RE" && return 0
    printf '%s' "$1" | grep -Eq -- "$ANY_R_RE" || return 1
    uses_key "$1" && return 0
    lm_pid=$(printf '%s' "$1" | awk '{print $1}')
    case "$lm_pid" in
        ""|*[!0-9]*) lm_home=$HOME ;;
        *) lm_home=$(owner_home "$lm_pid") ;;
    esac
    default_key_of "$1" "$lm_home"
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

STOP=""
if [ "$SURVEY" = 0 ]; then
    STOP=$(mktemp "${TMPDIR:-/tmp}/telepy-stop-$T_ID.XXXXXX" 2>/dev/null) || STOP="$HOME/.telepy-stop-$T_ID.sh"
    if ! printf '#!/bin/sh\n# telepy-remove-tunnel stop script for tunnel #%s (deletes itself)\nsleep 2\n' "$T_ID" > "$STOP"; then
        out failed stopscript "$STOP"
        exit 0
    fi
    chmod 700 "$STOP"
fi
STOPS=0
LATE=""
# Stopping steps go into the stop script; logs are deleted last, once their writers have stopped (LATE).
# A survey only reports.
later() { [ "$SURVEY" = 1 ] && return 0; printf '%s\n' "$1" >> "$STOP"; STOPS=$((STOPS + 1)); out scheduled "$2" "$3"; }
latelog() {
    if [ "$SURVEY" = 1 ]; then out found log "$2"; return 0; fi
    LATE="$LATE$1
"; STOPS=$((STOPS + 1)); out scheduled log "$2"
}
# known_hosts files the removed parts used (UserKnownHostsFile=…); deleted at the end when nothing else uses them.
OLD_KH=""
note_kh() {
    for nk in $(printf '%s\n' "$1" | grep -oE -- "UserKnownHostsFile[= ]['\"]?[^ '\"]+" | sed -E "s/^UserKnownHostsFile[= ]['\"]?//"); do
        nk=$(expand_path "$nk")
        case "$nk" in /dev/null) continue ;; esac
        case "$(basename "$nk")" in *telepy*) ;; *) continue ;; esac
        kept_new "$nk" && continue
        case " $OLD_KH " in *" $nk "*) ;; *) OLD_KH="$OLD_KH $nk" ;; esac
    done
}
# Files the stop script deletes (left out when checking whether anything still uses known_hosts).
GOING=" "
FOUND_JOIN=0

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Delete; fall back to sudo; else report that root is needed. A survey reports it as found.
rmf() {
    [ -e "$1" ] || [ -L "$1" ] || return 0
    if [ "$SURVEY" = 1 ]; then out found "$2" "$1"; return 0; fi
    rm -f "$1" 2>/dev/null
    if { [ -e "$1" ] || [ -L "$1" ]; } && [ -n "$SUDO" ]; then $SUDO rm -f "$1" 2>/dev/null; fi
    if [ -e "$1" ] || [ -L "$1" ]; then out needs_root "$2" "sudo rm -f $1"; else out removed "$2" "$1"; fi
}

# --- systemd (system units: join as root, the autossh service script, units written by hand) ---------
if command -v systemctl >/dev/null 2>&1; then
    for f in /etc/systemd/system/*.service /lib/systemd/system/telepy*.service /usr/lib/systemd/system/telepy*.service; do
        has_port "$f" || continue
        name=$(basename "$f")
        out found systemd "$f"
        [ "$name" = "telepy-tunnel-$T_ID.service" ] && FOUND_JOIN=1
        [ -n "$T_INSTALL" ] && [ "$name" = "telepy-$T_INSTALL.service" ] && FOUND_JOIN=1
        note_kh "$(text_of "$f")"
        [ "$SURVEY" = 1 ] && continue
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
        out found systemd-user "$f"
        [ "$name" = "telepy-tunnel-$T_ID.service" ] && FOUND_JOIN=1
        [ -n "$T_INSTALL" ] && [ "$name" = "telepy-$T_INSTALL.service" ] && FOUND_JOIN=1
        note_kh "$(text_of "$f")"
        [ "$SURVEY" = 1 ] && continue
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
        out found launchd "$f"
        [ "$label" = "com.telepy.tunnel.$T_ID" ] && FOUND_JOIN=1
        [ -n "$T_INSTALL" ] && [ "$label" = "com.telepy.tunnel.$T_INSTALL" ] && FOUND_JOIN=1
        note_kh "$(text_of "$f")"
        case "$f" in
            /Library/*)
                if [ "$ROOT" = 0 ] && [ "$SURVEY" = 0 ]; then
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
for r in "$HOME/.ssh/telepy-tunnel-$T_ID.sh" ${T_INSTALL:+"$HOME/.ssh/telepy-$T_INSTALL.sh"}; do
    if has_port "$r"; then
        RUNNERS="$RUNNERS $r"
        FOUND_JOIN=1
    fi
done
# Other loops in ~/.ssh that run this tunnel with its key, running or not: told apart by what they do, not by name
# (a deleted tunnel's loop is left behind when a rejoin writes a new key to the same file).
for r in "$HOME"/.ssh/telepy-*.sh; do
    case "$r" in *-uninstall.sh|*-ws.sh) continue ;; esac
    case "$RUNNERS " in *" $r "*) continue ;; esac
    has_port "$r" && RUNNERS="$RUNNERS $r"
done
PIDS=""
pinfo() {
    if [ -r "/proc/$1/cmdline" ]; then tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null
    else ps -o args= -p "$1" 2>/dev/null; fi
}
uid_of() {
    if [ -r "/proc/$1/status" ]; then awk '/^Uid:/ { print $2; exit }' "/proc/$1/status" 2>/dev/null
    else ps -o uid= -p "$1" 2>/dev/null | tr -d ' '; fi
}
# The home of the account that runs a process (this account's own from the login's HOME).
owner_home() {
    oh_uid=$(uid_of "$1")
    if [ -n "$oh_uid" ] && [ "$oh_uid" = "$MY_UID" ]; then printf '%s' "$HOME"; return 0; fi
    oh_name=""
    if [ -n "$oh_uid" ] && command -v getent >/dev/null 2>&1; then oh_name=$(getent passwd "$oh_uid" 2>/dev/null | cut -d: -f1); fi
    [ -n "$oh_name" ] || oh_name=$(ps -o user= -p "$1" 2>/dev/null | tr -d ' ')
    home_of "$oh_name"
}
# Who runs a process, and their home (this account's own come from the login: HOME / LOGNAME).
owner_of() {
    oo_uid=$(uid_of "$1")
    oo_name="" oo_home=""
    if [ -n "$oo_uid" ] && [ "$oo_uid" = "$MY_UID" ]; then
        oo_name=${LOGNAME:-$ME}
        oo_home=$HOME
    else
        if [ -n "$oo_uid" ] && command -v getent >/dev/null 2>&1; then oo_name=$(getent passwd "$oo_uid" 2>/dev/null | cut -d: -f1); fi
        [ -n "$oo_name" ] || oo_name=$(ps -o user= -p "$1" 2>/dev/null | tr -d ' ')
        case "$oo_name" in ""|*[!A-Za-z0-9._-]*) return 0 ;; esac
        oo_home=$(eval "printf '%s' ~$oo_name" 2>/dev/null)
    fi
    out found owner "$1 $oo_name $oo_home"
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
# A running tunnel to another server with this key: keep the key (and that tunnel).
ELSEWHERE=$(printf '%s\n' "$ALL" | grep -E -- "$ANY_R_RE" | grep -E 'ssh' | grep -v 'telepy-remove-tunnel' | grep -v 'telepy-stop-' | while IFS= read -r l; do foreign "$l" && uses_key "$l" && printf '%s\n' "$l"; done)
if [ -n "$ELSEWHERE" ]; then
    KEY_ELSEWHERE="$KEY_ELSEWHERE (a running ssh)"
    printf '%s\n' "$ELSEWHERE" | while IFS= read -r l; do
        [ -n "$l" ] && out kept other-server "$(printf '%s' "$l" | cut -c1-400) (port $(dial_ports "$l" | head -n 1))"
    done
fi
while IFS= read -r line; do
    pid=$(printf '%s' "$line" | awk '{print $1}')
    case "$pid" in ""|*[!0-9]*) continue ;; esac
    out found process "$line"
    owner_of "$pid"
    note_kh "$line"
    [ "$SURVEY" = 1 ] || check_owner "$pid"
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
            [ "$SURVEY" = 1 ] || check_owner "$pp"
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
    [ "$SURVEY" = 1 ] && return 0
    if [ -z "$KEEP" ]; then printf '' | $1 crontab - 2>/dev/null; else printf '%s\n' "$KEEP" | $1 crontab - 2>/dev/null; fi
    if [ "$?" = 0 ]; then out removed cron "crontab of $2"; else out failed cron "could not rewrite the crontab of $2"; fi
}
if command -v crontab >/dev/null 2>&1; then
    crontab_clean "" "$ME"
    [ -n "$SUDO" ] && crontab_clean "$SUDO" root
fi
# OpenWrt (procd) init scripts and /etc/rc.local: what a router's tunnel is usually started from.
if [ -f /etc/rc.common ]; then
    for f in /etc/init.d/*; do
        has_port "$f" || continue
        name=$(basename "$f")
        out found initd "$f"
        # The one-command join's procd service is named after the install id (`/etc/init.d/telepy-<id>`).
        [ -n "$T_INSTALL" ] && [ "$name" = "telepy-$T_INSTALL" ] && FOUND_JOIN=1
        note_kh "$(text_of "$f")"
        [ "$SURVEY" = 1 ] && continue
        if [ "$ROOT" = 1 ]; then
            $SUDO "$f" disable >/dev/null 2>&1
            later "$SUDO $(q "$f") stop >/dev/null 2>&1; $SUDO rm -f $(q "$f")" stop "init.d $name"
            GOING="$GOING$f "
        else
            out needs_root initd "sudo $f disable; sudo $f stop; sudo rm -f $f"
        fi
    done
fi
if [ -f /etc/rc.local ]; then
    RL=$(rd /etc/rc.local)
    RL_KEEP=$(printf '%s\n' "$RL" | while IFS= read -r l; do line_is_mine "$l" || printf '%s\n' "$l"; done)
    for r in $RUNNERS; do RL_KEEP=$(printf '%s\n' "$RL_KEEP" | grep -vF -- "$r"); done
    if [ "$RL_KEEP" != "$RL" ]; then
        printf '%s\n' "$RL" | grep -v -x -F -- "$RL_KEEP" | while IFS= read -r l; do [ -n "$l" ] && out found rc.local "$l"; done
        if [ "$SURVEY" = 0 ]; then
            if [ "$ROOT" = 1 ] && printf '%s\n' "$RL_KEEP" | $SUDO tee /etc/rc.local >/dev/null; then out removed rc.local /etc/rc.local
            else out needs_root rc.local "remove the Telepy line from /etc/rc.local"; fi
        fi
    fi
fi

for r in $RUNNERS; do
    out found loop "$r"
    note_kh "$(rd "$r")"
    # Its log: next to it, or wherever it appends (`>> /path/x.log`).
    logs="${r%.sh}.log $(rd "$r" | sed -n 's/.*>> *\([^ ]*telepy[^ ]*\.log\).*/\1/p' | tr -d "'\"")"
    [ "$SURVEY" = 1 ] || rmf "$r" file
    GOING="$GOING$r "
    for log in $logs; do
        if [ -f "$log" ]; then
            case "$GOING" in *" $log "*) continue ;; esac
            latelog "rm -f $(q "$log")" "$log"
            GOING="$GOING$log "
        fi
    done
done

# Downloaded scripts of this tunnel that are not running (ssh / autossh / docker templates).
for f in "$HOME"/*.sh "$HOME"/*.yml "$HOME"/*.yaml "$HOME"/Downloads/*.sh "$HOME"/Downloads/*.yml "$HOME"/Desktop/*.sh; do
    has_port "$f" || continue
    out found script "$f"
    [ "$SURVEY" = 1 ] || rmf "$f" file
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
# A rename keeps the key: the new service logs in with it.
SSH_DIR="$HOME/.ssh"
if [ "$T_MODE" != relabel ]; then
    for k in "$SSH_DIR"/telepy_tunnel_*; do
        case "$k" in *.pub) continue ;; esac
        [ -f "$k.pub" ] || continue
        if awk '{print $2}' "$k.pub" 2>/dev/null | grep -qxF -- "$T_KEY"; then
            if [ -n "$KEY_ELSEWHERE" ] && [ "$SURVEY" = 0 ]; then
                out kept key "$k (a tunnel to another server uses it too:$KEY_ELSEWHERE)"
            else
                [ -n "$KEY_ELSEWHERE" ] && out note key-shared "$k"
                rmf "$k" key
                rmf "$k.pub" key
            fi
        else
            out kept key "$k (another tunnel's key)"
        fi
    done
fi
for U in "$SSH_DIR/telepy-uninstall-$T_ID.sh" ${T_INSTALL:+"$SSH_DIR/telepy-$T_INSTALL-uninstall.sh"}; do
    kept_new "$U" && continue
    if [ -f "$U" ] && grep -qF "(#$T_ID)" "$U" 2>/dev/null; then
        if [ "$FOUND_JOIN" = 1 ] || grep -qF "tunnel $T_NAME (#$T_ID)" "$U" 2>/dev/null || grep -qF "tunnel $T_INSTALL (#$T_ID)" "$U" 2>/dev/null; then
            out found join "$U"
            rmf "$U" file
        fi
    fi
done
# The SSH-over-WebSocket carrier (used by this tunnel only; a rename copied it to the new name first).
for f in "$SSH_DIR/telepy-ws-$T_ID.py" "$SSH_DIR/telepy-ws-$T_ID.sh" ${T_INSTALL:+"$SSH_DIR/telepy-$T_INSTALL-ws.py" "$SSH_DIR/telepy-$T_INSTALL-ws.sh"}; do
    kept_new "$f" && continue
    [ -f "$f" ] && rmf "$f" file
done
# A switch replaced an earlier install id: the files that id left behind (record, uninstall script, known_hosts,
# carrier). Its service is matched by the key like any other; these are only the bookkeeping files.
if [ "$T_MODE" = relabel ] && [ -n "$T_OLD_INSTALL" ] && [ "$T_OLD_INSTALL" != "$T_INSTALL" ]; then
    for f in "$SSH_DIR/telepy-$T_OLD_INSTALL.install" "$SSH_DIR/telepy-$T_OLD_INSTALL-uninstall.sh" "$SSH_DIR/telepy-$T_OLD_INSTALL.known_hosts" "$SSH_DIR/telepy-$T_OLD_INSTALL-ws.py" "$SSH_DIR/telepy-$T_OLD_INSTALL-ws.sh"; do
        [ -f "$f" ] && rmf "$f" file
    done
fi
# The install record the join script wrote (what it installed, where, as whom; no secrets). A survey reports it.
# dbclient has no UserKnownHostsFile: the join pinned the gateway in the account's ~/.ssh/known_hosts and listed the
# exact lines it added in the record (KNOWN_HOSTS_LINE=…). Only those lines go; the account's other known hosts stay.
REC="$SSH_DIR/telepy-$T_INSTALL.install"
if [ -n "$T_INSTALL" ] && [ -f "$REC" ]; then
    out found record "$REC"
    DBKH=$(sed -n 's/^DBCLIENT_KNOWN_HOSTS=//p' "$REC" 2>/dev/null | head -n 1)
    if [ -n "$DBKH" ] && [ -f "$DBKH" ] && grep -q '^KNOWN_HOSTS_LINE=' "$REC" 2>/dev/null; then
        if [ "$SURVEY" = 1 ] || [ "$T_MODE" = relabel ]; then
            out found known_hosts "$DBKH (lines listed in $REC)"
        else
            sed -n 's/^KNOWN_HOSTS_LINE=//p' "$REC" > "$DBKH.telepy-lines"
            if grep -vxF -f "$DBKH.telepy-lines" "$DBKH" > "$DBKH.telepy-tmp" 2>/dev/null || [ ! -s "$DBKH.telepy-tmp" ]; then
                cat "$DBKH.telepy-tmp" > "$DBKH" && out removed known_hosts "$DBKH (the lines the join added)"
            else
                out failed known_hosts "$DBKH"
            fi
            rm -f "$DBKH.telepy-tmp" "$DBKH.telepy-lines"
        fi
    fi
    [ "$SURVEY" = 1 ] || [ "$T_MODE" = relabel ] || rmf "$REC" record
fi
# known_hosts: the ones the removed parts used, plus (delete) the join's. Kept while anything else still uses one:
# a unit, a plist, a loop, or this computer's own ssh config (a device is often someone's laptop too).
KHS="$OLD_KH"
if [ "$T_MODE" = delete ]; then
    for k in "$SSH_DIR/telepy_known_hosts" ${T_INSTALL:+"$SSH_DIR/telepy-$T_INSTALL.known_hosts"}; do
        case " $KHS " in *" $k "*) ;; *) KHS="$KHS $k" ;; esac
    done
fi
for KH in $KHS; do
    [ -f "$KH" ] || continue
    if [ "$SURVEY" = 1 ]; then out found known_hosts "$KH"; continue; fi
    USERS=""
    for f in /etc/systemd/system/*.service "$HOME"/.config/systemd/user/*.service /Library/LaunchDaemons/*.plist "$HOME"/Library/LaunchAgents/*.plist /etc/init.d/telepy* "$SSH_DIR"/telepy-*.sh "$SSH_DIR/config" "$SSH_DIR"/telepy/*.conf; do
        [ -f "$f" ] || continue
        case "$GOING" in *" $f "*) continue ;; esac
        grep -qF "$KH" "$f" 2>/dev/null && USERS="$USERS $f"
    done
    case "$KH" in "$SSH_DIR"/telepy_known_hosts) grep -qF "telepy_known_hosts" "$SSH_DIR/config" 2>/dev/null && USERS="$USERS $SSH_DIR/config" ;; esac
    if [ -n "$USERS" ]; then out kept file "$KH (still used by$USERS)"; else rmf "$KH" file; fi
done

if [ "$SURVEY" = 1 ]; then
    :
elif [ "$STOPS" -gt 0 ]; then
    printf '%s' "$LATE" >> "$STOP"
    printf 'rm -f "$0"\n' >> "$STOP"
    out stopscript sh "$STOP"
else
    rm -f "$STOP"
fi
out done "$OS" "$ME"
