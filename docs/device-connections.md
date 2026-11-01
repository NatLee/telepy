# How the backend reaches devices

<p align="center"><b>English</b> | <a href="./device-connections.zh-TW.md">繁體中文</a> | <a href="./device-connections.ja.md">日本語</a></p>

This is the most technical of the user docs. It follows a connection from Telepy's backend to a device's sshd: which ways a device can come in, how the backend makes sure it is talking to the right machine, how it shares connections, which ports it uses, and what it leaves on the device.

It is written for admins who want to understand the moving parts, or who need to find out why something stopped working. If you came here with a problem, these sections are the usual suspects:

- Devices can't reach SSH because the web name sits behind Cloudflare or another web proxy: [A separate name for SSH](#a-separate-name-for-ssh).
- Every device seems to come from your load balancer's address: [Behind an L4 proxy: PROXY protocol](#behind-an-l4-proxy-proxy-protocol).
- A device's host key changed, or you see `device_claimed`: [Pinning the device's host key](#pinning-the-devices-host-key) and [One owner per machine](#one-owner-per-machine).
- A service on the device is marked "To change" or "Extra copy": [Names on the device](#names-on-the-device).

## The big picture

![The path of a terminal session: browser, Telepy, the device's sshd](images/en/terminal-flow.png)

The device side is plain OpenSSH. With its tunnel key, the device runs `ssh / autossh -NR '*:0:localhost:22' telepy@<server> -p 24242`.

- Current scripts always ask for `-R 0`. The gateway recognises the tunnel by its key and picks the number itself (see [The tunnel is identified by its key](#the-tunnel-is-identified-by-its-key)).
- The scripts pin the gateway's host key with `StrictHostKeyChecking=yes` and `HostKeyAlias=telepy-<host>-<port>`. Older scripts that carry a port number keep working.
- On networks that only let web ports out, the very same SSH travels inside a WebSocket (see [The web port](#the-web-port-websocket)).

On the server, the connection lands on the gateway, an SSH server built into the backend process. (It used to be a separate OpenSSH container.)

```
Device
  sshd :22
     ▲
     │ ssh -NR with the tunnel key; every channel inside the tunnel is attached to localhost:22
     ▼
Telepy backend (one process)
  gateway :2222 (public 24242)
     │ forward table: reverse_port → this device's connection (no local port is bound)
     │
     ├─ connection pool: one SSH connection per device + OS account
     │    ├ web terminal: one PTY channel per tab
     │    ├ file manager / SFTP: one shared sftp channel (exec fallback: one channel per command)
     │    ├ remote browser: built-in SOCKS5, one direct-tcpip per CONNECT
     │    └ LAN host hop: one direct-tcpip (the last hop is still OpenSSH)
     ├─ AI sessions, LAN scans: their own connection each (channels still opened inside the backend)
     └─ laptops: ssh -W <tunnel name>:22 telepy@server (user key) → a channel
```

Whichever path a feature takes, it ends in **one SSH login to the device's sshd**. The backend logs in with the tunnel's own service key (see [One service key per tunnel](#one-service-key-per-tunnel)); a laptop logs in with the user's own key.

| Feature | How it reaches the device |
|---|---|
| Device → server | `ssh -NR` (`-R 0`) to the gateway inside the backend; can also be wrapped in a WebSocket at `/ws/gateway/` |
| Web terminal | A PTY channel on a shared connection. Tabs and the file manager for the same device and account share **one** SSH login |
| File manager / SFTP | SFTP REST and every file manager share **one** sftp channel on that connection. Without an sftp subsystem, the file manager runs `ls -la` over an exec channel |
| Remote browser | The backend's own SOCKS5 proxy (CONNECT only); each CONNECT is a direct-tcpip channel on the shared connection |
| LAN host terminal | A direct-tcpip channel on the shared connection, handed to OpenSSH through a one-shot local entry point. The last hop is OpenSSH, so it can ask for a password |
| Device key lists | Borrow a connection from the same pool and read / write `~/.ssh/authorized_keys` over SFTP |
| Laptop | `ProxyCommand ssh -W` through the gateway |

Before the Rust backend, every one of these went through the OpenSSH container, and every file operation started its own `ssh` or `scp`: two SSH hops each time.

## How a device reaches the gateway

![How your computer reaches Telepy, next to how the device connects](images/en/transport-info.png)

A device can come in on the SSH port, on the web port inside a WebSocket, or try the SSH port first and fall back to the web port. Whatever the way in, the SSH inside is the same, with the same keys and rules.

### The SSH port

This is the default. Devices connect to `REVERSE_SERVER_SSH_PORT` (24242; 2222 inside the container).

The name they dial is `SSH_SERVER_DOMAIN`, which you can also set under Site settings → Server → "SSH host". Left empty, it is the same name as the web UI.

### A separate name for SSH

![Why SSH can need its own name](images/en/ssh-host.png)

When the web name sits behind a proxy that only carries web ports (Cloudflare's orange cloud, another CDN, an HTTP load balancer), that name can't reach the SSH port. Give SSH its own name that goes straight to the server.

- The known_hosts alias (`telepy-<domain>-<port>`) keeps using the web domain, so changing the SSH host doesn't make Telepy look like a different server.
- Devices already installed keep dialling the name they were set up with.
- The settings page looks up both names and recognises Cloudflare's addresses. It can't recognise other proxies. `doctor`'s `ssh_host` check does the same.

The SSH name should not serve the web UI. When `PUBLIC_URL` is set and the SSH host is a different name:

- a sign-in that arrives under the SSH name is answered with 421 (`ssh_host`), and the frontend shows a page pointing back to the proper address;
- the settings page won't save the name you are browsing on, because that would lock you out.

This catches wrong addresses and configuration mistakes. It doesn't stop a forged `Host` header; for that, lock the origin so that only the proxy can reach it.

### The web port (WebSocket)

For networks that only let web ports out: corporate networks, hotels, 4G routers.

The device's ssh gets `ProxyCommand ~/.ssh/telepy-<install id>-ws.sh`. That small wrapper runs a **carrier**, a program that wraps ssh's bytes in binary WebSocket frames and sends them to the web port.

Inside is the very same SSH session: the same host key, the same key login and forward rules. Nothing extra is trusted, and there is no separate auth message, because authentication happens in the SSH inside.

Choose it in the wizard's connection step or in the one-command join (`transport: websocket`). What got installed shows up on the Device tab as the `carrier` fact: `binary <target>`, `python3` or `none`.

#### Which carrier a device gets

1. **The prebuilt `telepy-carrier`** (preferred): a static Rust binary, built on every release for x86_64, aarch64, armv7 and armv6 Linux, macOS and Windows.
2. **`python3` with `telepy-ws.py`** (standard library only, served at `GET /api/join/telepy-ws.py`): for CPUs without a prebuilt binary, such as MIPS routers.

The join script's `--carrier binary|python` forces one or the other.

How the binary gets to the device:

- The device downloads it from your own server at `GET /api/join/carrier/<target>` and checks it against the sha256 the server publishes at `…/sha256`.
- That sha256 comes from the release's `SHA256SUMS`, which the server accepts only with a valid `SHA256SUMS.sig` from a Telepy release key.
- The server fetches a platform from the release page the first time a device asks for it, and caches it in `CARRIER_DIR` (`<DATA_DIR>/carriers`). `telepy-server fetch-carriers` fills the cache in advance.
- With the site setting "Keep device carriers up to date" (on by default), the server checks the release page once a day, replaces older copies in the background, and tells every admin and the site-wide webhooks (`carriers.updated` / `carriers.update_failed`).
- Server health → Companion services → Device carriers shows each platform's version and lets you update by hand.

Both carriers go through an HTTP CONNECT proxy when the device has one (`HTTPS_PROXY` or `--proxy`; `NO_PROXY` is honoured). The join script bakes the proxy from its own environment into the wrapper, because services don't get an environment of their own.

#### What the gateway sees

- The source IP comes from `X-Forwarded-For`. Which entries count as proxies is set by Site settings → Server → "Trusted proxies" (or `TRUSTED_PROXY_HOPS`); the default `auto` treats every internal address at the right end as a proxy.
- The port is recorded as 0. The connection info, the `accepted` event and the tunnel list's `endpoint.transport` say `websocket`.
- The connection cap (`GATEWAY_MAX_CONNECTIONS`) counts both entry points together.

#### Laptops on the web port

Laptops can come in this way too. In the SSH config dialog, set "Reach Telepy via" to "Web port only", or to "Automatic" (adds `--tcp` and tries the SSH port first). The server block gains one ProxyCommand line, once `telepy-ws.py` is saved to `~/.ssh/telepy-ws.py`.

`telepy ssh / scp / sftp` don't use this helper: they go through the web port by default (see [cli.md](./cli.md)).

### Automatic: SSH port first

`transport: auto` is the default in the wizard and in the one-command join.

- The carrier gets `--tcp <SSH host>:<port>`. Each connection tries the SSH port directly first, and only counts it once the gateway's `SSH-` banner arrives.
- If that fails (a firewall, or a web name behind a proxy that only carries web ports), it falls back to the WebSocket.
- A working WebSocket is remembered for 30 minutes (a small file in the temp directory). After that, the SSH port is tried first again.
- Which way it took is written to stderr, which ends up in the service's log.
- A device with no carrier at all (no prebuilt binary for its CPU and no python3) uses only the SSH port, and the join says so.

The one-command join uses `--auto` and reports what it actually installed at registration (`facts.transport`, `facts.carrier`). Telepy stores that as the tunnel's way in (`way_in`).

### The built-in client

Some devices have an SSH client that can't talk to the gateway (stock OpenWrt's dbclient), or no SSH client at all. There, the same `telepy-carrier` binary runs the whole tunnel itself. The one-command join picks it (`--client builtin`) when the device has no OpenSSH client:

```
telepy-carrier tunnel --identity <key> --known-hosts <file> --server <SSH host>:<port> [--ws <url>] --forward 0:<sshd>
```

- It speaks SSH to the gateway on its own: host keys pinned, key login, `tcpip-forward` 0.
- It connects every channel the gateway opens to the device's sshd.
- It keeps its own 30-second keepalive, and exits when the link drops so the service manager restarts it.
- The way in (SSH port, web port or automatic) and the CONNECT proxy work as above. The service runs `~/.ssh/telepy-<install id>-ws.bin` directly.

Details and limits are in [device-join](device-join.md#1b-the-built-in-ssh-client-telepy-carrier-tunnel).

### Bring your own carrier

Telepy's carriers are helpers, not requirements. Any program that turns ssh's stdin / stdout into a TCP connection to the gateway can be a device's `ProxyCommand`.

For networks that even the web port can't cross as is (SNI-based filtering, throttled TCP), a general-purpose tunnel such as [wstunnel](https://github.com/erebe/wstunnel) does the job without any change to Telepy:

1. Run `wstunnel server` as one more container on the backend's network, with `--restrict-to backend:2222` (and a secret path through `--restrict-http-upgrade-path-prefix`).
2. Route one path to it in Traefik.
3. Give the device `ProxyCommand wstunnel client -L stdio://backend:2222 wss://<host>/<path>`.

The SSH inside is still Telepy's: the same keys, host-key pinning and forward rules.

What you give up:

- The gateway sees the wstunnel container as the peer, so the device's public address only shows up later, from the daily probe.
- The way-in badge reads SSH instead of SSH over WSS.
- The Device tab knows nothing about a service you installed by hand.

What you must get right:

- A wstunnel server allows everything by default. Without `--restrict-to` it is an open relay into the compose network, guacd and the remote browser's session manager included.
- Telepy neither ships nor manages it. wstunnel's protocol changes between major versions, so the client on every device has to move with the container.

### Behind an L4 proxy: PROXY protocol

When an L4 proxy sits in front of the gateway (nginx stream, HAProxy `mode tcp`, a cloud NLB), every connection seems to come from the proxy.

List the proxy under Site settings → Server → "PROXY protocol sources for the SSH gateway", or in `GATEWAY_PROXY_PROTOCOL_FROM` in `.env`:

- IPs or CIDRs, separated by commas or spaces. Empty means off.
- If `.env` sets it, `.env` wins and the page locks the field.
- The source in the proxy's v1 / v2 header then replaces the peer everywhere: events, endpoint, who is using the tunnel, IP-change alerts.

How the gateway handles it:

- **Optional and auto-detected**: the gateway peeks at the first byte. SSH always starts with `S`, a PROXY header with `P` or `\r`. If nothing arrives for 5 seconds, the peer is treated as a direct client waiting for the banner.
- **Byte-exact**: reading stops at the end of the header and never touches the SSH after it, so a wrong setting never locks out a device that connects directly.
- v1 `UNKNOWN` and v2 `LOCAL` keep the peer. A malformed header, or one not finished within 5 seconds, is refused and logged as a `refused_proxy` event. A connect-and-close (a health check) isn't logged.
- **Unlisted sources never have a header read.** Otherwise anyone could claim any IP, and the IP-change alert would mean nothing.

Scripts on the device need no change.

## The tunnel is identified by its key

The gateway already knows which tunnel is connecting when the key logs in. So when the device asks to forward a port, the number it asks for doesn't matter:

- Asking for 0, or for someone else's number, makes no difference. The forward is recorded under the tunnel's own number (`reverse_port`), and that is the number returned to the device.
- When the requested number differs, the `forward` event notes it.
- A user key can't identify a tunnel, so as before it may only forward the numbers of tunnels its owner owns.

Device scripts always write `-R 0` (`SSH_TUNNEL_PORT=0` in the Docker flavours, and in the one-command join too). The number exists only on the server.

The removal script that runs when you delete a tunnel finds the tunnel's things the same way, by **key**: `-i <key file>` or `IdentityFile` in a command line or file, Docker's `KEY_FILE=` or `<path>:/id_rsa`, or a key a container mounts at `/id_rsa`. The `.pub` next to it, or `ssh-keygen -y`, has to produce the tunnel key. Older scripts that carry a port number are still recognised by the number.

When the one-command join's background loop is re-run, it finds the old ssh by this tunnel's own known_hosts file (`telepy-<install id>.known_hosts`). The number can't identify it, and the key file may also serve a tunnel on another Telepy server (see [Leaving other servers alone](#leaving-other-servers-alone)).

### Laptops connect by tunnel name

A laptop's `direct-tcpip` accepts `<tunnel name>:<any port>` as well as `localhost:<number>`; names are unique across the site. So the device block in the generated ssh config is simply `HostName <name>` / `Port 22`, reached through `ProxyCommand ssh -W %h:%p <server block>`. Older config files keep working.

Names are matched ignoring case, because OpenSSH lowercases `HostName` before putting it in `%h` (`MyBox` reaches the gateway as `mybox`). An exact match wins; otherwise the gateway picks the one this key may reach. Matching used to be exact, so a tunnel with capitals in its name was refused (`administratively prohibited`).

Who may connect hasn't changed: the owner, an ADMIN, or a sharee with at least one allowed account, and a sensitive tunnel needs a confirmation in the web UI first. The gateway refuses a personal key at login when:

- it has expired (logged as an `expired_key` event);
- the account is disabled;
- an admin has turned off the "Personal SSH keys" feature for that person.

### Tunnel names follow OpenSSH's rules

A tunnel name doubles as a host name in ssh_config, so it follows OpenSSH's rules: letters, digits and `.` `_` `-`, starting with a letter or digit, at most 63 characters, and unique ignoring case. Why everything else is out:

- A space splits one name into two in ssh_config, and OpenSSH 9.6 and later refuse it on the command line.
- `%` would be expanded like `%h`.
- `* ? ! ,` are pattern characters, and `#` starts a comment.
- `@` and `:` are Telepy's own: `<tunnel>@<account>` and `<tunnel>:<path>`.

Names from before the rule keep working. The generated config writes them as `HostName localhost` / `Port <number>`, and the web UI suggests a rename to the owner.

### Several Telepy servers in one ssh config

- The server block's alias is `telepy-<domain>-<port>` (the same string as its `HostKeyAlias`), one per Telepy server, so several servers can share one config without stepping on each other.
- The install command removes the older shared `telepy-ssh-server` block only when it is sure the block belongs to this server and nothing else uses it.
- When two servers both have a device with the same name, the install command checks which server the existing block's ProxyCommand goes through. If it is another server's, the block is kept, not overwritten, and the command lists the names it kept.
- Give one of the servers a "Name prefix" (the personal setting `ssh_alias_prefix`, for example `work-` → `ssh work-pi`), and both can live side by side.

## Trusting the right machine

A device can't tell Telepy users apart: it only sees a service key it trusts. So Telepy has to make sure of three things itself: the machine on the other end is the one it met before, it belongs to one account, and it trusts only its own tunnel's key.

### Pinning the device's host key

Every time the backend connects to a device, it checks the host key the device's sshd presents.

- **First connection**: the key is recorded (trust on first use). Usually that is the backend's own check login right after the device joins.
- **A different key later**: the handshake is refused, the new key is kept as pending, and the owner and sharees are notified.
- **What to do**: the owner or an ADMIN opens the tunnel details, goes to "Keys & identity" → "Device identity", compares the fingerprint with the device and clicks "Trust this key". "Forget" clears the pin, so the next connection records the key afresh.

Why bother: whoever holds a tunnel key can point its `-R` at their own sshd and pose as the device. They would catch terminal input, uploaded files and remote-desktop passwords. With the pin, the impostor is stopped at the handshake, and the service-key login is never sent.

Laptops check the device the same way. In the generated ssh config, the device block uses `UserKnownHostsFile ~/.ssh/telepy_known_hosts` and `HostKeyAlias <server alias>-device-<tunnel id>`:

- Once Telepy has pinned the key, the block says `StrictHostKeyChecking yes`, and the pinned lines sit in the same file as the server's. The install command, `telepy config install` and `telepy ssh` all save them together.
- Before Telepy has pinned it, the block says `accept-new`: the laptop records the key on its first connection and refuses a different one afterwards.
- After the owner trusts a new key, laptops have to re-run the install command once.

The device block used to say `StrictHostKeyChecking no`, so a tunnel pointed at someone else's sshd would take a laptop's `ssh <device>` straight there.

### One owner per machine

While devices trust a shared service key (as all of them once did, and older ones still do), whoever can point a tunnel at a machine's sshd could log in with their own tunnel's account list, root included. Pointing is easy: `-R <port>:<that machine>:22` from any account on the machine, or from the same LAN or VPN. The pinned host key stops this, because it doubles as the machine's identity.

**Before pinning, Telepy checks who else trusts the same key.**

- Another account's tunnel: the handshake is refused. The error starts with `device managed by another account`; the API and remote desktop report the code `device_claimed`.
- The refused tunnel logs `claim_refused`. The machine's own tunnel logs `claim_attempt`, and its owner and ADMIN sharees get a `DEVICE-CLAIM-ATTEMPT` notification, once per key.
- "Trust this key" and "forget, then reconnect" follow the same rule, so neither is a way around it.
- Your own other tunnel: pinned as usual, and `GET …/host-key` lists it under `same_machine`.

**The join script sends the host key at registration** (`ssh-keyscan` on the device itself).

- A machine that belongs to another account is refused before the tunnel is created (409). The message suggests asking the owner for a share, or regenerating the host key if the machine is a cloned VM.
- Your own other tunnel comes back as `SAME_MACHINE_AS`, and the web UI points it out.
- The new tunnel's host key is pinned at once, so the first connection no longer trusts whatever it sees.
- On a rejoin, a pin is added only when none exists yet or at least one key matches. If every key changed, the check at connect time refuses it.

**More rules in the same spirit:**

- Device keys are unique across the site, whatever the comment or owner. A device key can't be another person's personal key (your own is fine: the computer you work from can be a device too) or a service key, because the gateway recognises only keys, and the tunnel registered first would be treated as that key's device.
- Laptop SSH through the gateway needs at least one allowed account: a sharee with none can't open a channel to the device's sshd. The allow-list is the only boundary; ADMINs manage it, so they are the exception.

When a tunnel is deleted, its pin goes too. The machine has no owner again, and the next tunnel pointed at it pins it. Delete always removes the tunnel's own service key from the device. If the old shared key is still there, tick "Also remove the shared Telepy key from …" in the delete dialog (already ticked for the last tunnel on a machine) so the machine really leaves Telepy.

### One service key per tunnel

Pinning keeps out someone else's machine; per-tunnel keys pull out the root of the problem. There used to be one service key for the whole site (`SSH_IDENTITY`), trusted by every device. Now:

- Each tunnel generates its own ed25519 key pair the first time it needs one.
- The private key is sealed with a key derived from `SECRET_KEY` and stored in the database.
- The public key (`… telepy-tunnel-<id>`) goes to the wizard, the one-command join, the Docker scripts and the tunnel details. The device authorises only that one.

How it plays out:

- **Login order**: the tunnel key first, and the shared key only while the device doesn't have the tunnel key yet. A login with the tunnel key marks that account as verified.
- **Migrating older devices**: on the next key sync, the tunnel key is installed into every login account, and the next connection uses it. The shared key leaves an account only after **every tunnel on the same machine that lists that account** has logged in with its own key (event `service_key_migrated`).
- **By hand**: the device key panel marks the shared key "Shared · legacy". Managers can remove it under the same rule.
- **Moving servers**: Site settings → Server → "Keep the shared service key on devices" (or `KEEP_SHARED_SERVICE_KEY=true` in `.env`) keeps the shared key on every device, automatically and by hand. Use it while the previous Telepy server still logs in to the same devices with that key. The tunnel key is still installed and still tried first.
- **Deleting a tunnel** always removes its own key from the device. The delete dialog's service-key option now only concerns the shared key.
- **No collisions**: a tunnel's service public key can't be registered as a device key or a personal key.

> [!WARNING]
> Changing `SECRET_KEY` makes the sealed keys unreadable, and those tunnels fall back to the shared key. `doctor`'s `tunnel keys` check reports how many. Devices whose shared key is already gone have to be authorised again (wizard step 3, or the one-command join).

## One shared connection per device and account

A fresh SSH login for every click would be slow, and the device's auth log would start to look like a break-in attempt. So the backend keeps **one SSH connection per tunnel and OS account** and opens channels on it.

- Telepy users who are allowed the same OS account share one connection, each with their own channel. Permissions are still checked before anything is borrowed.
- The connection opens on first use and runs entirely inside the backend: a forwarded-tcpip channel on the device's tunnel, with the SSH handshake to the device's sshd on top. If several requests arrive at once, only one handshake runs and the rest wait for it.

### Session limits (MaxSessions)

OpenSSH's MaxSessions limits only session channels (shell, exec, sftp), not direct-tcpip, so that is all the pool counts.

- Session channels are terminal tabs, exec, device key lists and the macOS name resolver.
- At most 8 run on one connection at once. sshd's default MaxSessions is 10, and 2 stay spare: the device frees a slot only after it has handled our close (a shell has to exit first), so reusing a slot the instant it comes back can be refused.
- If a device sets MaxSessions lower and refuses a channel, the pool remembers how many that connection really holds and opens a second connection. The learned limit expires after 2 minutes, since a refusal may be momentary.
- Features that open only direct-tcpip (the remote browser's SOCKS, remote desktop and RustDesk, the LAN hop) take a lease instead: it keeps the connection from being reclaimed but takes no slot. They used to take one slot each, so a remote browser plus a remote desktop left terminal tabs two slots short.

### Files share one sftp channel

SFTP requests are numbered, so many people can use one channel at once. Each connection opens just one sftp channel, and SFTP REST and every file manager go through it.

- **Benefit**: no reopening a channel, requesting the subsystem and running INIT for every request, which costs several round trips over the tunnel. However many file managers are open, they take one slot.
- **Cost**: the device's sftp-server handles one request at a time, so one stuck request (say, on a hung network drive) makes everyone wait.
- **Safety net**: the backend counts requests sent and replies received. If the channel closes, or requests are waiting and nothing arrives for 15 seconds, the channel counts as broken and the next borrower gets a fresh one. A file manager whose directory listing fails swaps in a new channel and retries once.
- **Idle**: after 5 minutes unused, the sftp channel is closed and its slot returned, even if the connection itself is still busy.
- **No sftp subsystem**: when the device refuses it, the file manager falls back to exec as soon as the refusal arrives, instead of waiting out SFTP's 10-second start-up timeout.

### Idle connections, tabs and offline devices

- A connection that nothing is borrowing and that has been idle for more than 5 minutes is closed (checked every 30 seconds).
- When the device disconnects, its connection invalidates itself, open terminal tabs are closed, and the next use reconnects.
- A terminal tab is a channel, and closing a tab closes only that channel. Under the old design, one `killpg` could hit the shared ControlMaster and close every tab at once, which was efficient in the wrong direction.
- An offline device gets close code 4005 right away, with no waiting for a timeout.

### Macs and host names

Apple's `sshd-session` has a sharp edge. When it receives a direct-tcpip whose target is a **name**, its privilege-separated child calls getaddrinfo after fork and aborts, taking the whole SSH connection with it.

Chromium always sends names through SOCKS, so the remote browser hits this the moment it opens a page. On a shared connection, the terminal tabs and file manager for that device and account would drop with it. So before the SOCKS proxy or the LAN hop opens a direct-tcpip, the backend:

- asks each connection's OS once (`uname -s`);
- on Darwin, resolves the name **on the device** with `/usr/bin/dscacheutil` (IPv4 first; internal and `.local` names work as usual) and opens the channel to the IP;
- on other systems, hands the name to the device as before, the same as `ssh -D`.

The details on a Mac:

- The same name looked up at the same time runs once, and at most 2 lookups run at once. Each borrows a session channel, so they count toward the limit above.
- Answers are cached for 60 seconds, and failures for 10.
- If a name can't be resolved, that CONNECT fails. The name is **never** handed to Apple's sshd.

### What sharing saves

For the same device and account, there is no handshake from the second operation on. Measured in the tests:

- 5 directory listings in a row: 1 login, 1 sftp channel
- 12 requests at once: 1 login, 1 sftp channel
- 3 terminal tabs plus the file manager: 1 login
- 10 leases plus 8 session channels: 1 login

## Ports: where they're used, and can they run out?

| Port | What it is for | How many | Can it run out? |
|---|---|---|---|
| 24242, 8787 | Public: device tunnels and the web UI (devices on the web port use 8787 too) | Fixed | No |
| `reverse_port` | One **number** per tunnel; the gateway files the device's forward under it. **No local port is bound** | 1 per tunnel | The number space allows about 64,500 tunnels |
| SOCKS port | One per remote-browser session; the browser container connects in. Chromium's SOCKS takes no credentials, so one can't be shared | Up to the session cap | No |
| LAN host one-shot entry | For each LAN host terminal, `127.0.0.1:<ephemeral port>` waits for one connection (closed after 30 seconds if nobody comes) | Open LAN terminals | No |
| Remote desktop call-back port | One one-shot listener per RDP / VNC session (random port, accepts only guacd's address). When guacd connects, it is joined to the device's direct-tcpip and the listener closes | Open desktop sessions | No |

The backend never goes through loopback TCP to reach a device, so there are no ephemeral ports to run out of and no TIME_WAIT pile-ups. `reverse_port` is only a number, so it can't collide with anything in the container; handing one out just means skipping numbers already taken.

## Names on the device

### Why the names changed

Some things on devices used to carry a person's or a server's name:

- a hand-written migration script's `telepy-natlee.service`, `info.natlee.telepy` and `telepy_natlee_known_hosts`;
- the tunnel name in the one-command join's unit description;
- `telepy-tunnel.service`, shared by every tunnel, so two tunnels on one machine overwrote each other;
- `~/.ssh/telepy_known_hosts`, so a second server joining overwrote the first one's host key.

Seeing `telepy-natlee` on someone else's machine tells them who runs the server. And Telepy didn't know what had been installed, so on delete it could only guess.

### The install id

Each tunnel draws a random 8-character id the first time it needs one, from `[a-hj-km-np-z2-9]`. It is unique across the site and deleted with the tunnel. Every name on the device comes from it:

| What | Name |
|---|---|
| systemd unit (system, `--user`, or the autossh service) | `telepy-<id>.service` |
| launchd job | `com.telepy.tunnel.<id>` |
| Background loop | `~/.ssh/telepy-<id>.sh` |
| Host keys | `telepy-<id>.known_hosts` |
| Uninstall script | `telepy-<id>-uninstall.sh` |
| Web-port carrier | `telepy-<id>-ws.*` |
| Docker container | `telepy-<id>` |

The unit's description says only `Telepy reverse tunnel <id>`.

- The id holds no user, domain or tunnel name, so renaming a tunnel doesn't touch the device. Searching for the id on the tunnels page finds the tunnel.
- It is random rather than a hash: without a record you couldn't get back to the original name anyway, and a hash would change with `SECRET_KEY`.
- The `telepy-` prefix stays so the device's admin can tell what it is. A service of unknown origin that keeps dialling out over SSH looks a lot like malware, which is not the first impression you want to make on someone else's admin.
- The ssh command still names the server it connects to (`telepy@<domain>`, `HostKeyAlias`), because the connection needs it.

### Surveying what is installed

The removal script that delete uses also has a survey mode. It changes nothing and only reports what it finds: unit and plist paths, loops, running ssh processes and their owners, crontab lines, containers, keys and known_hosts files.

The result is stored and refreshed:

- after a verified one-command join;
- in the daily device check, when the device was never surveyed or the last survey is older than 7 days;
- when you click "Check again" under "On the device" on the tunnel details' Device tab.

On Windows the script only removes things; the survey isn't done yet and returns just the platform.

What the survey copes with:

- **Files the login account can't read**: a unit running as root often keeps its key in `/root/.ssh`, which an account like `ubuntu` can't read. When the login account has `sudo -n`, keys, units and loop scripts are read with `sudo -n cat` / `test -f` / `ssh-keygen -y -P ''` (read-only, each file asked once).
- **Services that name no key**: when a command names no key file, explicitly dials this gateway's port and has a `-R`, it is matched against the running account's default keys (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`…). The running account is the process owner, the unit's `User=`, the plist's `UserName`, root for a system unit that names none, or else the login account. A default key is that person's own file, so delete never removes it.
- **launchd plists**: a plist puts each argument in its own `<string>`, so they are joined into one line before matching. Otherwise neither `-p` nor `-i` could be read.
- **OpenWrt**: procd init scripts (`/etc/init.d/*`, looked at only when `/etc/rc.common` exists) and lines in `/etc/rc.local` are recognised by the same rules. On delete an init script is disabled, then stopped and removed by the stop script; from rc.local only that line goes.
- **Dropbear's command limit**: OpenWrt routers often run Dropbear, which refuses an exec command over 9000 characters, and this script is 25 KB. Scripts over 6000 characters are sent in pieces (`printf >> <temp file>`), then one last exec runs the file and deletes it. Any sshd accepts that, and it also runs under BusyBox ash (Alpine).

### Leaving other servers alone

The same key may serve two Telepy servers, and matching by key alone once took down the other server's unit too. So when a file or command line names a port (`-p N`, `'-p' 'N'`, `Port=N`, `SSH_REMOTE_PORT=N`) and none of them is this gateway's `REVERSE_SERVER_SSH_PORT`, it belongs to another server (`kept other-server`). Delete, survey and rename all skip it. Anything that names no port is recognised as before.

### Renaming without going offline

A name Telepy didn't give (made by hand or by a migration script, such as `telepy-natlee.service`) is marked "To change", with a "Service name to change" chip in the tunnel list. "Rename on the device" replaces it with private names.

The catch: the rename itself travels through this tunnel, and stopping the old service first would be sawing off the branch you're sitting on. So the new service connects first, and the old one goes only after that:

1. **Plan**: survey again and work out a plan from the running ssh (its `-i`, `-p`, `-R` target, `user@host`, ProxyCommand) and the old services. The same method as before: a systemd system unit stays a system unit with the original `User=`; `--user` units, LaunchAgents and loops run as the account that runs them now; system level needs root or `sudo -n`. The same key, server, port and forward target, with known_hosts rewritten to this gateway's host keys. Anything that blocks the plan (Windows, needs root, a command it can't parse, a relative key path…) is explained in the web UI.
2. **Arm a handover**: for a while, a second connection of the same tunnel (recognised by the same tunnel key) isn't refused. Its forward is recorded as a standby and answered with success, so the new ssh's `ExitOnForwardFailure` doesn't make it quit. The forward stays on the old connection (event `standby_forward`).
3. **Install** over the old connection: files are written beside the old ones and then renamed, and the new service starts.
4. **Wait** for the standby to show up (45 seconds by default), then log in once through it.
5. **Switch**: the forward moves to the new connection (event `handover`). The old connection is still alive but no longer carries the tunnel.
6. **Remove the old service** over the **new** connection, with the same search delete uses, except that everything named after the id is skipped and the key stays. The old unit, plist, loop, crontab line, old known_hosts (if nothing else uses it) and old uninstall script go; the stop script runs in the background as usual.
7. **Confirm**: the old connection is gone, the forward is still on the new one, and no other connection turns up within 13 seconds (which would mean something is restarting the old service). Then survey once more (event `service_renamed`).

If any of steps 2–5 fails, Telepy removes what it just installed, over the old connection, and disarms the handover. The old service was never touched and the tunnel stayed online the whole time. If the old connection happens to drop midway, the standby takes over on its own, so that doesn't take the tunnel offline either.

The one cost: when the old connection closes, open web terminals and file managers on this device reconnect once, because their channels were on the old TCP connection.

Two kinds of names don't need this:

- **Telepy's own earlier names** (the one-command join's `telepy-tunnel-<n>.service` / `com.telepy.tunnel.<n>` / `telepy-tunnel-<n>.sh`, autossh's `telepy-tunnel.service`, the container `telepy-tunnel`) carry no person's name, and delete recognises them. They show as "Earlier Telepy name", and renaming them is optional ("Rename anyway").
- **A line in `/etc/rc.local`** can't be replaced by Telepy (the rename answers `unsupported`). Rename it by hand, or run the one-command join again, which installs it under the private name. OpenWrt's init scripts, on the other hand, are renamed like any other service.

### Several people and servers on one machine

- Different Telepy accounts can't point tunnels at the same machine (see [One owner per machine](#one-owner-per-machine)).
- Different OS accounts, or connections to different servers, used to collide on shared names: `telepy-tunnel.service`, the container `telepy-tunnel`, `/etc/ssh/telepy_known_hosts`, `~/.ssh/telepy_known_hosts`, and `telepy-tunnel-<n>` named by tunnel number (which two servers with a copied database share). All of them are named by the install id now.
- One OS account connecting to two servers **with the same key**: on delete, `~/.ssh/telepy_tunnel_*` stays as long as something that dials the other server (a unit, a script, a running ssh) uses it (`kept key … another server`). The one-command join's loop stops only its own ssh, matched by its known_hosts file rather than by the key.
- The survey reports things that dial another server as `kept other-server "<file or ssh> (port N)"`, and a shared key as `note key-shared <path>`. The Device tab's "Who this device connects to" diagram draws one row per server from them.

> [!NOTE]
> If you copy the whole database to run a second server, the install ids are copied too, so what the two servers install on the same device gets the same names.

### Cleaning up on delete

- Delete recognises the new names' unit, launchd label, loop, uninstall script, carrier files and `telepy-<id>.known_hosts`.
- A known_hosts file is deleted only when no unit, plist, loop, `~/.ssh/config` or CLI config still uses it. A device is often someone's laptop too, and `~/.ssh/telepy_known_hosts` may belong to that laptop's ssh config.
- When the one-command join is re-run and finds an install of the same tunnel under an older name (`telepy-tunnel-<id>`), it stops and removes that first, then installs the new one, so the two never fight over the tunnel.

### Extra copies

A name alone can't tell "a name a person chose" from "another install id": `telepy-natlee` looks like an id too. This came up on a real router. A survey flagged an init script as a name to change, but it was really left over from a deleted tunnel, and the rejoin had written the new key into the **same** key file. So the leftover used exactly the new tunnel's key, and after a reboot both would start and fight over the tunnel.

So Telepy asks three questions, and only the last one is about the name:

1. **Is it this tunnel's?** It uses this tunnel's key and dials this gateway.
2. **Which one is running?** When every ssh the survey saw is the one named after the install id (its command line carries `telepy-<id>.known_hosts`), every other service or container of the tunnel is an **extra copy**, whatever it is called. It isn't a name to change, and a rename answers `extra`.
3. **Does the name give a person away?** Only names made from the install id are private. When a tunnel is deleted, its id, name and owner go into a ledger, and new ids never reuse them. A `telepy-<x>` or `com.telepy.tunnel.<x>` in a name is marked as left over from that deleted tunnel only when it matches the ledger, and the tunnel's name is shown only to the same owner. Telepy's earlier standard names are a fixed list.

"Remove the extra copy" on the Device tab (or `POST …/device-install/tidy`) needs no handover, because the extra copy isn't the one connected:

1. Survey again. There has to be an extra copy, the device can't be Windows, and a system-level copy needs a root login.
2. Over the **current** connection, run the same cleanup as a rename: everything named after the id is skipped and the key stays. An init script is disabled, then stopped and removed by the stop script, and of the known_hosts files only the one that copy used goes with it.
3. Watch for 13 seconds: the connection stays, the forward doesn't move, and no other connection turns up.
4. Survey again to confirm (event `service_extra_removed`).

The removal script also scans `~/.ssh/telepy-*.sh`. A loop that dials this server with this tunnel's key counts as this tunnel's even when it isn't running, so a dormant loop left behind by a deleted tunnel is found too.

## Not done yet

- **AI sessions and LAN scans still open their own connection.** One AI session runs up to 4 channels at once (commands and interactive shells share them) plus SFTP, so counting it as a single session would make the pool underestimate the device's MaxSessions use. It already opens its channels inside the backend, with no port involved, so sharing a connection would save just one handshake. It hasn't been moved.
- **The `reverse_port` ceiling.** Tunnels are identified by their key, the number a device asks for in `-R` doesn't matter, and laptops use `ssh -W <tunnel name>:22`. But `reverse_port` is still an internal 16-bit number per tunnel. Past about 60,000 tunnels it has to widen to a bigger integer: a change to the type and the allocator only, with nothing to change on devices or laptops. It is a problem we'd be delighted to have.

## Tests

<details>
<summary>What the end-to-end tests cover (for contributors)</summary>

Every SSH path here is tested end to end on the SSH lab in `tests/common/lab.rs`: a real gateway, sshd machines and real OpenSSH clients. New SSH paths are built on it too.

- `tests/terminal_e2e.rs`:
  - PTY and echo (multi-byte characters included), resize sent as window-change, binary pong.
  - Five independent tabs; closing one leaves the rest working.
  - Tabs share one login, and a third tab still opens with MaxSessions 2.
  - Tabs close when the device drops and reopen after it reconnects; offline answers 4005 straight away.
  - The LAN host hop; the file manager's SFTP and exec fallback share the connection.
- `tests/socks_e2e.rs`:
  - A real SOCKS5 CONNECT through the device to a service on its LAN, several at once, and an unreachable target.
  - The proxy port closes after stop; `device_offline` when offline.
  - A fake macOS device that drops the connection on a direct-tcpip to a name, like Apple's crash: CONNECT by name still works, and a terminal tab on the same connection stays alive.
- `tests/device_pool.rs`:
  - Connection and sftp channel sharing, counted from the device sshd's logins and sftp start-ups.
  - A second connection when MaxSessions is below 8; leases take no slot.
  - A broken shared sftp is replaced and an unused one closed; the file manager swaps in its own.
  - A refused sftp subsystem leaves no channel behind on the device.
  - Device reconnect, idle reclaim, and a connection in use is not reclaimed.
- `tests/ssh_topology.rs`: several users and OS accounts on one device, multi-hop paths, and a sharee with no allowed account.
- `tests/gateway_ws.rs`: a device connecting through `/ws/gateway/`, with the real `telepy-ws.py` as ProxyCommand.
- `tests/proxy_protocol.rs`: the PROXY header from an L4 proxy (the lab sets the proxy address with `Lab::start_with(|config| …)`).
- `tests/key_identified.rs`, `tests/tunnel_delete.rs`: tunnels identified by key, and what delete finds on the device.
- `tests/host_keys.rs`: host-key pinning.
- `tests/laptop_device_host_key.rs`: the laptop side, with a fake sshd and a comparison with the old config.
- `tests/machine_identity.rs`: pointing a tunnel at someone else's machine, two ways around the rule, your own second tunnel, release after delete.
- `tests/join_api.rs`: refusal at registration, the same-machine note, the immediate pin.
- `tests/rest_api.rs`: device key de-duplication.
- `tests/tunnel_service_keys.rs`: a new device trusts only the tunnel key, an older device migrates, the wait for every tunnel on the same machine, removal on delete.
- `tests/device_install.rs`: a real `/bin/sh` device, with a real reconnect loop as the old service and fake `crontab` / `ssh` in `<home>/bin`.
  - The forward is never released during a rename, and a new service that can't connect is undone.
  - A deleted tunnel's leftover loop is found as an extra copy, traced through the ledger, and removed without a drop.
  - The planner and the naming code have unit tests of their own.

</details>
