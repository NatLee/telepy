# One-command device join

<p align="center"><b>English</b> | <a href="./device-join.zh-TW.md">繁體中文</a> | <a href="./device-join.ja.md">日本語</a></p>

Adding a Linux machine, a Mac or an OpenWrt router to Telepy takes one line. You paste it on the device, and a small script looks at what the device has, sets up a key and a reverse tunnel that runs as a service, and only calls it done once Telepy has really logged in through that tunnel.

The device only ever dials out to Telepy, so nothing is opened on its router. The command works once, expires after 30 minutes, and can only add a device to your own account.

![Why a reverse tunnel: without Telepy, the device dials out, you come in through the tunnel](images/en/setup-story.gif)

This page walks through running it, what it leaves on the device and how to remove it, then the special cases: OpenWrt and Dropbear, devices without a usable SSH client, networks that block the SSH port, and compat mode. If it has already failed on you, jump to [When it fails](#8-when-it-fails).

Windows isn't covered here: the script doesn't run there, so use **Step by step** instead.

## 1. Run it

### Get the command

1. Go to **Tunnels → Create Tunnel** and keep **One command (Linux / macOS / OpenWrt)** selected. It's the default.
2. Optionally give the device a name. Under **Your SSH keys on this device**, **Install my keys** puts your personal keys on the device as soon as it connects, so you can ssh in from your own computer.
3. Choose **How the device reaches Telepy**: **Automatic** (the default, and the recommended one), **SSH port** or **Web port only**. See [Networks that block the SSH port](#5-networks-that-block-the-ssh-port).
4. Click **Create the command**.

Then choose how to run it:

- **With sudo (recommended)** installs a system service that keeps the tunnel up after logouts and reboots. Telepy logs in as the account that ran sudo.
- **Without sudo** installs a user service, which may stop when you log out. Use it when you can't use sudo, or when you are root already, as on an OpenWrt router.
- **Paste into a shell** is the usual way.
- **Download, check, run** is for routers and serial consoles, where a paste can lose characters. The file is downloaded first and checked with `sh -n` before it runs. There is a `wget` variant for machines without curl.

Copy the real command from the page. It looks like this:

```sh
curl -fsSL '<telepy>/api/join/install.sh' | sudo sh -s -- --token tpj_… --auto
```

**View the script** shows exactly what will run, if you'd like to read it first. Pasting the script's own text into a terminal is not supported.

### Test first with `--check`

`--check` does everything up to the registration and uses no token. It reports which shell, HTTP tool, SSH client and service manager it found, checks this machine's SSH server and host key with a strict handshake, and checks that it can reach Telepy's gateway, including whether SSH keepalives work on this build. It writes no files and registers nothing.

The page has it under **Test first without using the command**:

```sh
curl -fsSL '<telepy>/api/join/install.sh' -o /tmp/telepy-join.sh && sh /tmp/telepy-join.sh --check
```

### What happens on the device

The script goes through seven steps, and at each one it prints what it found and why it chose what it did:

1. Looks at what the device has: shell, HTTP tool, SSH client, SSH server and service manager.
2. Reads this machine's SSH host key and verifies it with a strict handshake.
3. Checks that the Telepy gateway answers, pins its host key and tests keepalives.
4. Creates the tunnel key and registers the device with the one-time token.
5. Adds Telepy's service key where this SSH server reads keys. It only appends, and only once.
6. Installs the tunnel as a service and starts it.
7. Waits until Telepy has logged in through the tunnel.

Steps 1–3 happen before the token is used, so a problem there costs you nothing.

![A device running the one command; the page follows each step](images/en/join-live.gif)

The page follows along: waiting, registered, tunnel connected, Telepy logged in. Telepy itself only sees the registration, the tunnel and the login; everything before that is printed on the device.

At the end the script reports five states separately: files installed, starts at boot, process running, tunnel connected, login verified. It only says Done once Telepy has really logged in.

It waits about two minutes for that login. The wait is counted in rounds of a loop (60 × 2 s) rather than by the clock, so a router whose clock time-travels a few years when NTP catches up after boot neither waits forever nor gives up at once.

### What it looks at

The script assumes nothing: no bash, no GNU tools, no python, no curl, no full OpenSSH. Instead it checks:

- **Shell**: BusyBox ash, bash, dash or plain sh. The script is plain POSIX sh (tested on BusyBox ash), so this is only reported.
- **HTTP tool**: `curl`, then `wget` (one that supports `--post-data`), then `uclient-fetch`.
- **SSH client**: a real OpenSSH first, else [Telepy's built-in client](#1b-the-built-in-ssh-client-telepy-carrier-tunnel), else Dropbear's dbclient. `--client openssh|builtin|dbclient` forces one.
- **SSH server**: who listens on the SSH port, on which address, and what it is.
- **Host key**: every candidate it can find, each one verified against the server that is listening right now.
- **Where keys go**: the file this SSH server really reads for that account.
- **Service manager**: procd (root on OpenWrt), systemd (system or `--user`), launchd, else a background loop with an `@reboot` crontab entry. After installing, it checks again that the service runs and is enabled.
- **Storage**: it warns when the key directory is on tmpfs or ramfs, which a reboot wipes (OpenWrt's `/tmp`, for example). Pass `--ssh-dir` then.
- **Package manager**: opkg, apk, apt, dnf, yum, zypper, pacman, brew or pkg. It is only used to phrase "X is missing" as a command you can copy on this machine; the script installs nothing itself.

<details>
<summary>How each check works, and why it doesn't take the obvious shortcut</summary>

- **Shell**: the first line of `sh --help` mentioning BusyBox means ash; otherwise bash, dash or sh. The script never branches on the shell.
- **HTTP tool**: stock OpenWrt has no curl, and its `wget` is really uclient-fetch: no `--header`, no visible status code, and no body kept on an error. So the device endpoints accept `?soft=1` (always 200, with the real status on the first line as `STATUS=<code>`), and the registration ignores the Content-Type.
- **SSH client**: `-V` runs on both `ssh` and `dbclient`. `OpenSSH_` means OpenSSH, `Dropbear` means dbclient; `command -v ssh` succeeding proves nothing. Stock dbclient can't finish a key exchange with Telepy's gateway (see [OpenWrt and Dropbear](#4-openwrt-and-dropbear)), so it comes last.
- **OpenSSH options**: every option the tunnel will use is parsed once with `ssh -G`, so an unknown option fails now instead of after the connection is up.
- **dbclient options**: for an unknown `-o`, dbclient prints one `Ignoring unknown configuration option` line and then runs normally with exit 0 (measured on 2022.82), so its exit code can't be trusted. Instead `dbclient -o help` must list `ExitOnForwardFailure` (Dropbear 2016.73 or newer), and `-h` must show `-K` and `-R`.
- **Key tool**: OpenSSH uses `ssh-keygen`; the built-in client uses `ssh-keygen` when there is one, else `telepy-carrier keygen` (ed25519, OpenSSH format, mode 0600, `.pub` next to it); dbclient uses `dropbearkey`.
- **SSH server**: `/proc/net/tcp` shows who listens on that port and on which address. The banner comes from `nc -w 3` (`SSH-2.0-dropbear_2022.82`, `OpenSSH_9.6`), else from the `remote software version` line of `ssh -v`. A Dropbear bound only to the LAN interface (`option Interface 'lan'`) doesn't answer on 127.0.0.1, so the host-key check and the tunnel's target, `-R 0:<address>:<port>`, both use that LAN address instead.
- **Host key**: a key file existing doesn't mean it belongs to the server listening now, so every candidate is tested. The candidates are root's `dropbearkey -y /etc/dropbear/*_host_key`, `/etc/ssh/ssh_host_*_key.pub`, `ssh-keyscan` (without `-T`, which prints no key at all on builds with the ppoll bug from [compat mode](#6-compat-mode)) and, last, OpenSSH learning it once over loopback with `accept-new`.
- **Host key, the test**: each candidate gets one handshake with `StrictHostKeyChecking=yes` and a known_hosts holding only that key, and counts only if the handshake gets as far as `Permission denied`.
- **Host key, built-in client**: the check is `telepy-carrier tunnel --probe --host-key '<that key>'`, a full key exchange that trusts only that key and offers none of its own. Without ssh-keyscan, the same probe reads the key over loopback first.
- **Nothing passes**: the message then says whether the server answers but its key can't be read, or nothing is listening. It no longer tells you to install openssh-server.
- **Where keys go**: `~/.ssh` is only a guess. OpenWrt with Dropbear and root reads `/etc/dropbear/authorized_keys` (an OpenWrt patch). OpenSSH, where `sshd -T` is readable, reads the first `AuthorizedKeysFile`, with `%h` and `%u` expanded. Otherwise it's `~/.ssh/authorized_keys`. `--authorized-keys` overrides.
- **Service manager**: procd when root, `/sbin/procd` is running and `/etc/rc.common` exists. The checks after installing are procd `running` / `enabled`, `systemctl is-active` / `is-enabled`, `launchctl print`, and `pgrep` plus the crontab contents.
- **Storage**: the filesystem under `--ssh-dir` is looked up in `/proc/mounts`.
- **Package manager**: picked by what is on the PATH, like tailscale's install script, not by the distribution's name. Hints look like `opkg install dropbear && /etc/init.d/dropbear start` or `apk add openssh-client openssh-keygen`.
- **Timeouts**: `timeout` when present. Without it (stock OpenWrt, macOS) the script uses its own watchdog: the command runs in the background and is killed on a timer. The watchdog's own output is closed, or a `$(...)` around it would wait for it.

</details>

<details>
<summary>All options of the script</summary>

| Option | What it does |
|---|---|
| `--token TOKEN` | The join token from Telepy. Required unless `--check`; works once |
| `--check` | Preflight only; uses no token |
| `--user NAME` | The account Telepy logs in to. Default: the user who ran sudo, else the current user |
| `--ssh-port PORT` | Port of this machine's SSH server. Default: detected, else 22 |
| `--ssh-host ADDR` | Address the SSH server listens on. Default: detected |
| `--authorized-keys PATH` | Where this SSH server reads the account's keys. Default: asked from the server |
| `--client openssh\|builtin\|dbclient` | Which SSH client runs the tunnel |
| `--service procd\|systemd\|launchd\|loop` | How the tunnel is kept running. Default: what the machine has |
| `--no-service` | Same as `--service loop` |
| `--name NAME` | Tunnel name: letters, digits, `.`, `_` and `-`. Default: the name set in Telepy, else the hostname |
| `--auto` | The SSH port first, the web port when it is blocked |
| `--via-web` | The web port only (SSH inside a WebSocket) |
| `--carrier auto\|binary\|python` | The web-port helper. `auto` (default) = the prebuilt `telepy-carrier`, else python3 |
| `--compat-no-server-alive` | Force compat mode (TCP keepalive instead of SSH ServerAlive) |
| `--no-compat` | Never switch to compat mode automatically |
| `--ssh-dir DIR` | Where the key, known_hosts, install record and uninstall script go. Default: `~/.ssh` |

</details>

## 1b. The built-in SSH client (`telepy-carrier tunnel`)

Some devices have an SSH server but no SSH client that can work with Telepy, and used to need `opkg install openssh-client`:

- Stock OpenWrt only has Dropbear's dbclient, which can't finish a key exchange with Telepy's gateway ([why](#dropbears-client-and-telepys-gateway)).
- Some ssh builds time out as soon as ServerAliveInterval is set ([compat mode](#6-compat-mode)).
- dbclient can't read OpenSSH-format keys either.

Now the prebuilt `telepy-carrier` can run the reverse tunnel itself. It's the same small binary that carries SSH over the web port.

- **When it's used**: when there is no real OpenSSH client and Telepy has a `telepy-carrier` for the device's CPU. The script downloads it from Telepy and checks it against its sha256. `--client builtin` asks for it explicitly.
- **Where it exists**: Linux on x86-64, aarch64, armv7 and armv6, and macOS. MIPS routers (the GL-AR750S, for example) have none and still need the OpenSSH client.

The service runs a line like this:

```sh
~/.ssh/telepy-<id>-ws.bin tunnel --identity ~/.ssh/telepy_tunnel_ed25519 --known-hosts ~/.ssh/telepy-<id>.known_hosts \
    --user telepy --server <ssh host>:<port> [--ws wss://<host>/ws/gateway/] --no-proxy --forward 0:127.0.0.1:22 --keepalive 30
```

What it does:

- Logs in to the gateway with the tunnel key, which must be in OpenSSH format without a passphrase. Without ssh-keygen on the device, `telepy-carrier keygen` makes it.
- Checks the gateway's host keys against the file the script wrote, which holds the keys Telepy announced through `GET /api/join/gateway`. A different key refuses the connection (exit 3), and nothing is registered.
- Asks for `tcpip-forward` 0, just like `ssh -R 0:…`: Telepy recognises the tunnel by its key and assigns its number itself. Every connection Telepy opens goes to this machine's SSH server (`--forward 0:<address>:<port>`, the LAN address when Dropbear only listens there).
- Reaches Telepy the same ways as the web-port helper: the SSH port, the web port (`--via-web`), or the SSH port first with the web port as a fallback (`--auto`). If `HTTPS_PROXY` was set during the install, it goes through that HTTP CONNECT proxy.
- Sends an SSH keepalive after 30 seconds without traffic and gives up after three unanswered ones. These timers are its own, not ssh's, so the ppoll bug behind [compat mode](#6-compat-mode) can't touch it: one probe, never compat mode.
- Exits with a non-zero code when the connection ends and lets the service manager start it again (procd `respawn`, systemd `Restart=always`, launchd `KeepAlive`, or the loop). SIGTERM ends it cleanly.

What it doesn't do: no shell, no agent or X11 forwarding, no `~/.ssh/config`, and only one forward. Keys with a passphrase are refused.

How you'll recognise it:

- On the device it's `~/.ssh/telepy-<id>-ws.bin`, run directly by the service, with no wrapper.
- The install record says `CLIENT=builtin (…)`. The join facts say `client: builtin (…)`, which the page shows as **Built-in client**.
- Telepy reads its command line the way it reads `ssh -R` when it surveys the device, renames the service, switches the way in or deletes the tunnel: the key from `--identity`, the forward from `--forward`, the server from `--server` (another server's port is never touched) and the known_hosts from `--known-hosts`.

## 2. What stays on the device

The service and its files are named after a random install id (`<id>` below), never after a user, a server or the tunnel's name. That way Telepy knows exactly what to clean up later.

In `~/.ssh`, or wherever `--ssh-dir` points:

- **The tunnel key**: `telepy_tunnel_ed25519` and its `.pub` (OpenSSH and the built-in client), or `telepy_tunnel_dropbear` and its `.pub` (dbclient).
- **`telepy-<id>.known_hosts`**: the gateway's pinned host keys. dbclient can't use a file like this and does it differently; see [When dbclient runs the tunnel](#when-dbclient-runs-the-tunnel).
- **`telepy-<id>.install`**, the install record: the id, tunnel, server, who installed it, the run-as and login accounts, shell, client, SSH server, authorized_keys path, service kind and files, keepalive, compat mode, and every file created. It holds no token and no private key.
- **`telepy-<id>-uninstall.sh`**, the uninstall script.
- **The built-in client or the web-port helper**: `telepy-<id>-ws.bin` (or `telepy-<id>-ws.py` for python3). The helper also gets a small wrapper, `telepy-<id>-ws.sh`; the built-in client doesn't need one.

The service, depending on what the device has:

- **procd**: `/etc/init.d/telepy-<id>`. It restarts the tunnel 10 seconds after every exit and never gives up (`respawn 3600 10 0`), sends its output to `logread`, sets `HOME`, and names the run-as account when that isn't root.
- **systemd**: `telepy-<id>.service`, a system unit, or a `--user` unit without sudo.
- **launchd**: `com.telepy.tunnel.<id>`, a LaunchDaemon with sudo or a LaunchAgent without.
- **Neither**: a loop in `~/.ssh/telepy-<id>.sh` plus an `@reboot` crontab entry.

And one line in the account's authorized_keys: Telepy's service key, appended once.

## 3. Running it again, and removing it

### Running it again

- **Same key, same tunnel**: Telepy identifies the device by its tunnel key, so running a new command on the same device reuses the tunnel. An install left under Telepy's earlier naming (`telepy-tunnel-<n>`) is cleaned up on the way.
- **After a failed login**: fix the cause the page shows, create a new command and run it on the same device. It picks up the same tunnel.

### When the download or the answer got lost

- **A damaged download**: Telepy appends `# telepy-sha256: <hex>` to the script. Run from a file, the script checks it and says the download is damaged if anything is missing.
- **A broken first line**: a truncated start (once, line 2 arrived as `in this machine as a device…`), Windows line endings or a byte-order mark make sh fail on the first line, before the script can say anything. That's why **Download, check, run** runs `sh -n` first. `curl | sh` can't check itself, so it blocks nothing.
- **A lost registration answer**: the script never sends the registration twice. It asks `GET /api/join/<token>/status`; if the device is already registered or further, it fetches the same settings again with `GET /api/join/<token>/config` (same ticket, same tunnel). Otherwise it asks you to run the command again, since the ticket is still waiting.

`--check` never uses the token, so you can repeat it as often as you like.

### Removing it

**On the device**, run the uninstall script. The install prints the exact line at the end (`Uninstall: sh ~/.ssh/telepy-<id>-uninstall.sh`); use sudo if you installed with sudo. It stops and removes the service and the files the install made.

It keeps the tunnel key and the Telepy line in authorized_keys on purpose; delete them yourself if you no longer need them. For dbclient, it removes exactly the known_hosts lines the install added, nothing else.

**From Telepy**, delete the tunnel. While the device is online, **Remove the tunnel service from the device** (on by default) finds this install and removes it, including procd init scripts (disabled first, then stopped and deleted), the install record and dbclient's known_hosts lines. The device survey lists those parts as `initd`, `record` and `known_hosts`.

## 4. OpenWrt and Dropbear

Stock OpenWrt is the hardest case and the one that shaped the script most: BusyBox ash, no curl, Dropbear as both SSH server and client, procd, and a `/tmp` that is gone after a reboot. What the script does about each:

- **No curl**: `wget` on OpenWrt is uclient-fetch, and the script copes with it. **Download, check, run** has a `wget` variant.
- **The SSH client**: on stock OpenWrt, `ssh` is Dropbear wearing an OpenSSH name tag. On x86-64 and ARM routers the built-in client runs the tunnel, so no extra package is needed. On MIPS routers, install the OpenSSH client (`opkg install openssh-client openssh-keygen`) and the script uses it.
- **The SSH server**: the host keys are read as root with `dropbearkey -y`. A Dropbear that only listens on the LAN address is reached on that address.
- **Telepy's key**: root's keys live in `/etc/dropbear/authorized_keys`, and that's where the service key goes.
- **The service**: a procd init script, `/etc/init.d/telepy-<id>`, that restarts the tunnel 10 seconds after every exit. Its logs are in `logread`.
- **Storage**: the script warns when `--ssh-dir` sits on tmpfs.

### Dropbear's client and Telepy's gateway

On a router with only dbclient and no built-in client (in practice, MIPS), the tunnel can't come up yet. Every Dropbear client sends a guessed first packet during the key exchange, and Telepy's gateway miscounts it when strict key exchange is on, then drops the connection.

It's a bug in russh, the SSH library behind the gateway. A fix of about 20 lines is proposed upstream as [Eugeny/russh PR #805](https://github.com/Eugeny/russh/pull/805) (issue [#804](https://github.com/Eugeny/russh/issues/804)).

Telepy doesn't carry a patched copy and waits for the upstream release; once Telepy upgrades, dbclient works without any change to the script.

Until then, the script's gateway check catches it before the token is used and stops with `the gateway closed the connection during the key exchange`, suggesting to update Telepy or install the OpenSSH client and re-run with `--client openssh`. OpenWrt routers with the OpenSSH client (both GL.iNet routers that were tested) aren't affected.

<details>
<summary>The details of the strict key exchange bug</summary>

OpenWrt 23.05 backported the Terrapin fix (`kex-strict-c-v00@openssh.com`) to Dropbear 2022.82. Dropbear's key exchange list starts with `kexguess2@matt.ucc.asn.au`, and it always sends a `first_kex_packet_follows` guess.

After ignoring a wrong guess, russh 0.64.1 sees the real `KEX_ECDH_INIT` at sequence number 2, treats it as a strict key exchange violation (`strict kex violated at sequence no. 2, message type: 30`) and disconnects. Any Dropbear client is affected; the newer 2024.86 also guesses and also supports strict key exchange. OpenSSH clients never guess, which is why this never came up before.

RFC 4253 §7.1 allows guessing, and OpenSSH servers have always accepted Dropbear. The fix shifts the sequence check by one after an ignored guess. A gateway with that fix was tested with dbclient 2022.82 on stock OpenWrt in Docker: connected, then verified.

</details>

### When dbclient runs the tunnel

These details matter once the gateway accepts Dropbear's client, or when you force it with `--client dbclient`:

- **Version**: dbclient needs `ExitOnForwardFailure` (Dropbear 2016.73 or newer) and the `-K` and `-R` options.
- **Keepalive**: dbclient uses its own `-K 30`, which disconnects after three unanswered probes. It isn't affected by the ppoll bug and never gets compat mode.
- **Its own key format**: dbclient 2022.82 can't read an OpenSSH-format private key (`Exited: String too long`, measured), so the two clients keep separate key files. With `dropbearconvert` the key is converted and the device keeps its tunnel; without it, a new key means a new device in Telepy's eyes, and the script says so. Stock OpenWrt has no `dropbearconvert`.
- **known_hosts**: dbclient has no `UserKnownHostsFile` or `HostKeyAlias`, so the gateway's host key goes into the run-as account's `~/.ssh/known_hosts` as `<gateway host> <type> <key>`. No comment is allowed after the key: dbclient decodes the rest of the line as the key, and a comment makes it mismatch (measured).
- **Only those lines**: the lines added are listed in the install record as `KNOWN_HOSTS_LINE=`, and both the uninstall script and tunnel deletion remove only those.
- **Name clashes**: dbclient compares host names, not ports. If the same host name already has a different key of the same type, the script stops and explains.
- **A fixed path**: the service names `/usr/bin/dbclient` itself. On stock OpenWrt `ssh` points to dropbear, but a later `opkg install openssh-client` replaces it with OpenSSH; a service calling `ssh` would then run OpenSSH with dbclient's arguments (`-K 30 -I 0` read as other options, ending in a connection to `0.0.0.30`).
- **The web port**: dbclient goes through the same helper wrapper with `-J`.

## 5. Networks that block the SSH port

Some networks only let the web port out, and some web names sit behind a proxy that only carries web traffic. The tunnel can ride inside a WebSocket on Telepy's web port instead. The SSH session inside, its keys and its host-key check stay the same.

- **Automatic** (`--auto`, the page's default): the SSH port first, the web port whenever that is blocked, decided again on every connection.
- **Web port only** (`--via-web`): always the web port.

Either way the device needs a small helper:

- **The prebuilt `telepy-carrier`** for the device's CPU, downloaded from Telepy and checked against its sha256. With the built-in client, the client is its own helper.
- **python3**, when there is no prebuilt helper for that CPU.
- **Neither**: with Automatic the tunnel simply uses the SSH port and the script says so; with Web port only, it's an error.

`--carrier auto|binary|python` picks the helper yourself.

If the device needs an HTTP proxy to get out, set `HTTPS_PROXY` (or `https_proxy`) when you run the command. Services have no environment of their own, so the script writes the proxy into the service's command.

The gateway check before registration tells you when this is needed: if both test handshakes time out or can't connect, outbound TCP to the gateway's port is blocked. Allow it, or use `--auto` or `--via-web`. How the web port works on Telepy's side is described in [Device connections](device-connections.md).

## 6. Compat mode

Before registering (which uses up the token), the script asks Telepy for the gateway's address, port, account and host keys through the public `GET /api/join/gateway`, pins the keys, and connects twice:

1. with `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`;
2. without.

Same gateway, same options; only ServerAlive differs. Neither connection sends a key (`PubkeyAuthentication=no`): a full key exchange that ends in `Permission denied` counts as success, and the gateway records no event for it.

| First | Second | What the script does |
|---|---|---|
| ok | — | Normal SSH keepalives (`keepalive=ssh`), as before |
| timeout | ok | Switches to compat mode |
| timeout or unreachable | timeout or unreachable | Stops: outbound TCP to the gateway is blocked. Use `--auto` or `--via-web`. Compat mode is not applied |
| host key mismatch | — | Stops: the gateway's host key isn't the one Telepy announced |

The second row is a real bug, OpenWrt #12574. On some builds, fortify-headers' `ppoll` reads a 64-bit `time_t` as 32-bit, so on big-endian ath79 routers such as the GL-AR750S, 30 seconds becomes 30 nanoseconds. That's not long enough to wait for anything, let alone a key exchange: ssh times out the moment any timeout is set.

Compat mode turns SSH keepalives off: `ServerAliveInterval=0 -o TCPKeepAlive=yes`. The join facts record it as `facts.compat = ["no_server_alive"]`, and the page and the tunnel's events show it (**Compat mode: SSH keepalives are off on this device**).

- `--no-compat` forbids the automatic switch: the script stops and explains instead.
- `--compat-no-server-alive` forces compat mode.

What it costs, printed on the device and kept in the facts and the install record:

- **No SSH heartbeat**: a dead link is only noticed by TCP keepalive, and the kernel default is often two hours.
- **A running process proves little**: procd and systemd restart ssh only after it exits, so a live process doesn't mean a working tunnel.
- **A workaround, not a fix**: the underlying package bug is still there.

dbclient (with its own `-K 30`) and the built-in client (one probe, its own timers) never need compat mode.

## 7. What works after joining

Most of Telepy works the same on small Dropbear / BusyBox devices:

| Feature | On Dropbear / BusyBox devices |
|---|---|
| Terminal | Works (a PTY shell; ash) |
| File manager / SFTP | Without an sftp-server (on OpenWrt: `opkg install openssh-sftp-server`), the file manager falls back to exec. The SFTP REST API needs sftp |
| Device key lists (installing people's keys when you share) | Without the sftp subsystem, keys are written over exec (`cat`, then a temporary file and `mv -f`). Root on OpenWrt with Dropbear gets `/etc/dropbear/authorized_keys`, the same file the join uses |
| Device facts, LAN scan | The scripts are POSIX / BusyBox-compatible. `ifconfig` stands in when `ip` has no `-o`; without `getent`, names aren't resolved |
| Renaming the service, switching the way in | Work with procd (`/etc/init.d/telepy-<id>`, the same shape the join installs). Surveying and deleting work too |
| Remote desktop / browser | Go through the device sshd's direct-tcpip, which Dropbear allows by default |
| Native Windows | No one-command join; use Step by step |

One Dropbear limit Telepy works around for you: it refuses exec commands over 9000 bytes.

Telepy's survey and delete scripts are about 25 KB, so long scripts are written to a temporary file on the device in pieces of up to 6000 characters (with `umask 077`), then run with `sh` and deleted. Short scripts still go as one `sh -c`. Writing key lists over exec is split the same way.

Before this, Dropbear simply closed the channel and Telepy reported `the script stopped early (exit None)`.

## 8. When it fails

The script stops with a message that says what to do next. Here are the usual ones, quoted the way the script prints them, by when they happen.

### Before the token is used

Nothing has been registered yet, so fix the cause and run the same command again.

- `cannot reach <Telepy address>`: the device can't reach Telepy's web address. With wget or uclient-fetch, https also needs CA certificates (the message names the package for this machine), and a wrong clock breaks TLS too.
- `no SSH server answers on <address>:<port>`: nothing listens there. Start an SSH server (the message gives this machine's install command), or point the script at the right one with `--ssh-port` / `--ssh-host`. On a Mac, turn on Remote Login under System Settings > General > Sharing.
- `the SSH server on … answers, but its host key could not be read`: run as root, or install openssh-client (for ssh-keyscan). Typical on OpenWrt without root.
- `none of the host keys found … matched the server`: another SSH server may be listening there. Pass `--ssh-port` / `--ssh-host` for the right one.
- `no SSH client: no OpenSSH, no built-in client … and no dbclient`: install the OpenSSH client (the message shows how), or ask your Telepy admin to make `telepy-carrier` available (`telepy-server fetch-carriers`).
- `cannot connect to <gateway>` or `cannot complete an SSH handshake with <gateway>`: outbound TCP to the gateway's port is blocked. Allow it, or use `--auto` / `--via-web` ([Networks that block the SSH port](#5-networks-that-block-the-ssh-port)).
- `the gateway's host key does not match what Telepy announced`: whatever answered on the gateway's address isn't the gateway Telepy described, so the script stops.
- `the handshake times out as soon as ServerAliveInterval is set`: you ran with `--no-compat` on a build with the ppoll bug. Re-run without it, or with `--compat-no-server-alive` ([Compat mode](#6-compat-mode)).
- `the gateway closed the connection during the key exchange`: Dropbear's client and the gateway don't get along yet. Install the OpenSSH client and re-run with `--client openssh` ([Dropbear's client and Telepy's gateway](#dropbears-client-and-telepys-gateway)).
- `… has Windows line endings (CRLF)`, `… starts with a UTF-8 byte-order mark` or `… is damaged or incomplete (checksum mismatch)`: download the script again with `curl -o` or `wget -O` instead of saving it through an editor.
- `<known_hosts file> already has a different … key for <gateway host>` (dbclient only): remove that line if it is stale, or install OpenSSH and re-run with `--client openssh`.

### At registration

- `This join command is invalid or has expired.` or `This join command was already used.`: commands work once and expire after 30 minutes. Create a new one in Telepy.
- `This machine is already managed by another Telepy account`: its SSH host key is pinned by another account's tunnel. Ask that account to share the device with you. If this machine is a clone, regenerate its host keys (`ssh-keygen -A`) and try again.
- `this machine is already your tunnel '<name>'`: only a warning. Two tunnels to one machine work, but they manage accounts and keys separately; adding this account to the existing tunnel is usually tidier.

### After registration

- `the tunnel did not come up within 120 seconds`: the service keeps retrying every 10 seconds, and Telepy shows the device once it connects. Check the logs from the `Logs:` line the script printed (`logread -e telepy-<id>`, `journalctl -u telepy-<id> -f`, or `tail -f` on the loop's log file), and make sure outbound TCP to the gateway's port is allowed.
- `login verified` says `NO: …` (the page: the tunnel is up, but the test login failed): fix the cause shown, then run a new command on the same device. It reuses the same tunnel.
- `the tunnel is up, but Telepy has not finished checking the login`: open the device in Telepy from the link the script printed.
- `the tunnel stops when <user> logs out`: a user service without sudo. Run `sudo loginctl enable-linger <user>`, or re-run with sudo. On a Mac without sudo, the LaunchAgent likewise only runs while you are logged in.
- `started in the background, but it will NOT come back after a reboot`: there is no service manager and crontab failed. Start it again after a reboot, or fix crontab and re-run.
- `<dir> is on tmpfs: everything written there is lost at reboot`: pass `--ssh-dir` with a directory that survives a reboot.

## 9. Known limits

- **Windows**: native Windows (PowerShell, scheduled tasks, ACLs) still uses Step by step; the one-command script doesn't run there. Telepy doesn't claim support for anything it hasn't implemented or verified.
- **dbclient-only routers without a built-in client (MIPS)**: they can't reach the gateway until the russh fix ships ([details](#dropbears-client-and-telepys-gateway)). The script says so before using the token; installing the OpenSSH client is enough.
- **dbclient's known_hosts**: it compares host names only, so one host name can't hold two keys of the same type, and there is no `UserKnownHostsFile` or `HostKeyAlias`. Without `dropbearconvert` (stock OpenWrt has none), keys can't be converted when you switch clients.
- **Compat mode**: a workaround, not a fix. The SSH heartbeat is off and drops are noticed slowly.
- **OpenWrt without root**: when `/etc/dropbear/*_host_key` isn't readable and there is no `/etc/ssh/*.pub` and no ssh-keyscan, the host key has no source. The script stops and explains.
- **`/etc/rc.local`**: a hand-written tunnel line there isn't renamed or switched automatically.
- **No helper for the web port**: ARM routers (aarch64, armv7, armv6) get the prebuilt `telepy-carrier`. A router with another CPU (MIPS) and no python3 has no helper, so **Switch to automatic** installs a new service that uses only the SSH port, and says so (`no_carrier`).
- **Several addresses**: the script uses the SSH server's bind address as the tunnel's target. If the server is bound to several non-loopback addresses, it takes the first.

## 10. Where it has been tested

On real platforms, as of 2026-10-30 (the built-in client on 2026-11-01):

- **Stock OpenWrt 23.05.5** (x86-64, in Docker): joined and verified with the built-in client and no extra package, and again with the OpenSSH client installed. procd brought the tunnel back after a container restart.
- **GL.iNet GL-AR750S** (OpenWrt 22.03.4, MIPS, OpenSSH client, Dropbear server): `--check` passed, the ppoll bug was reproduced on real hardware, and a full join in compat mode reached verified, then uninstalled cleanly.
- **GL.iNet GL-MT3000** (aarch64, OpenSSH client, Dropbear 2024.86): `--check` passed with normal keepalives. Preflight only, no join.
- **Alpine 3.20** (ash, Dropbear server, OpenSSH client, no procd): joined as a background loop with a crond `@reboot` entry and verified; the uninstall removed the process and the crontab line.

Telepy's automated tests also run the served script with a real `/bin/sh` against a real gateway on every CI run.

<details>
<summary>Full test notes and the Docker recipe</summary>

**Automated (every CI run)**

- The backend's unit tests cover the facts allow-list, the soft responses, the checksum and the exec write commands.
- API tests cover the soft responses, `/api/join/gateway`, recovery through `/config`, form content types, and the facts reaching the ticket, the events and the device's install view.
- The script test runs the script the server sends (checksum included) with a real `/bin/sh` against the test lab's real gateway and a real HTTP listener, with a lab machine as the device's sshd.
- That test covers broken files and CRLF, `--check` using no token and writing nothing, the message for a wrong port, a real join through to verified, the record's contents, and the tunnel dropping after the uninstall. It passes on macOS `/bin/sh` with OpenSSH 10.3.

**Stock OpenWrt 23.05.5 rootfs** (x86-64 emulated under OrbStack; ash, BusyBox 1.36, Dropbear 2022.82 server and dbclient, uclient-fetch, procd started as `/sbin/init`, `--privileged`):

- `--check` passed: both host keys came from `dropbearkey -y` and were verified with strict handshakes, and the gateway's two host keys were pinned.
- A real join went connected → verified (root, through `/etc/dropbear/authorized_keys`), using the patched gateway for dbclient. After a container restart procd brought the tunnel back by itself.
- After a server restart, dbclient noticed the drop within about a minute with `-K 30`, and procd reconnected 10 seconds later.
- The device key list went through the exec fallback (`installed`, `verified`), and the panel showed `/etc/dropbear/authorized_keys`.
- The survey found the procd service, the process, the key and the record. After the uninstall the init.d and rc.d entries and the process were gone, the key stayed, and the gateway released the forward.

**The same rootfs with `opkg install openssh-client openssh-keygen`** (Dropbear server, OpenSSH 9.8 client, no ssh-keyscan): `--check` passed, the host keys again came from `dropbearkey -y`, and keepalive used OpenSSH's ServerAlive.

**Built-in client (2026-11-01)**: the stock rootfs without `openssh-client` (no ssh, ssh-keygen or ssh-keyscan; only dbclient), with a `telepy-carrier` for `x86_64-unknown-linux-musl` placed in `CARRIER_DIR` and served as is by `/api/join/carrier/<target>`.

- `--check` picked the built-in client: the ed25519 host key from `dropbearkey -y` was verified with `tunnel --probe`, the gateway probe worked over the SSH port, and no compat mode.
- A real join made the key with `telepy-carrier keygen` and reached connected → verified as the procd service `telepy-<id>` running `telepy-<id>-ws.bin tunnel …` (about 7 MB RSS). procd brought it back after a container restart.
- **Switch to automatic** moved it, make-before-break, to a fresh install id with both `--server` and `--ws`.
- Deleting the tunnel together with the service and the service key left no Telepy file in `/etc/init.d` or `/root/.ssh`, and no process.

**Alpine 3.20** (ash, Dropbear 2024.85 server, OpenSSH 9.7 client, no procd): `--check` passed with both the keyscan and the dropbearkey sources verified; a real join as a background loop with crond's `@reboot` reached verified; the uninstall removed the process and the crontab line.

**Real devices (2026-10-30, run through `telepy exec` from the production server, with a development server on the same LAN)**:

- **GL-AR750S** (OpenWrt 22.03.4, mips, BusyBox 1.35, OpenSSH 8.9p1 client, Dropbear 2022.82 server, curl):
  - `--check` passed. The two host keys from `dropbearkey -y` were right, and the two in `/etc/ssh/*.pub` were correctly judged "not the server listening now" and ignored.
  - The gateway probe timed out with ServerAlive and worked without it, so the script switched to compat mode by itself.
  - A real join installed the procd service `telepy-caqgap9k` and reached connected → verified (root, compat).
  - After the uninstall only production's own `telepy-47xzwr2e` remained, still running. The development server's forward was released, and the key and the authorized_keys line stayed by design (the development one was removed by hand).
  - Nothing in Dropbear or the network settings was touched.
- **GL-MT3000** (GL 21.02-SNAPSHOT, aarch64, BusyBox 1.33, OpenSSH 8.4p1, Dropbear 2024.86): `--check` passed, keepalive stayed on SSH (the ServerAlive handshake worked), and the host keys came from `dropbearkey -y`, ecdsa included. Preflight only.
- On both, BusyBox `nc` has no `-w` (it prints its usage), so the banner came from `ssh -v`. The script now retries `nc` under its watchdog when `-w` fails.

**Docker recipe**, with a Telepy server running natively on the host (API on 18872, gateway on 24872, `SERVER_DOMAIN=host.docker.internal`):

```sh
docker run -d --platform linux/amd64 --privileged --cgroupns=host --name telepy-wrt openwrt/rootfs:x86-64-23.05.5 /sbin/init
docker exec telepy-wrt sh -c 'wget -O /root/j.sh http://host.docker.internal:18872/api/join/install.sh && sh /root/j.sh --check'
docker exec telepy-wrt sh /root/j.sh --token tpj_…        # stock: the built-in client (with a telepy-carrier in CARRIER_DIR) + procd
docker exec telepy-wrt sh -c 'opkg update && opkg install openssh-client openssh-keygen' && docker exec telepy-wrt sh /root/j.sh --check
```

</details>
