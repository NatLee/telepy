<h1 align="center"><img src="./docs/brand/banner.png" alt="Telepy: reach every device from your browser" width="100%"></h1>

<p align="center"><b>English</b> | <a href="./README.zh-TW.md">繁體中文</a> | <a href="./README.ja.md">日本語</a></p>

Telepy is a self-hosted web console for machines you can't reach directly: servers behind NAT, a Raspberry Pi at
home, an office PC behind a firewall, an OpenWrt router. Each device dials out **one reverse SSH tunnel** to your
Telepy server, and from then on you work on it from the browser — terminal, files, remote desktop, a browser that goes
online through the device, and the machines on its LAN. Share devices with teammates under fine-grained permissions, and script
everything with the `telepy` command line, the REST API or MCP. Nothing is opened or installed on the device's
network beyond that one outbound SSH connection.

![The tunnels page: health, latency, how each device connects, public and LAN addresses, OS, labels, who is connected](./docs/screenshots/en/tunnels.png)

## What you can do

### Connect devices

- **One command on Linux, macOS and OpenWrt.** Paste a `curl … | sudo sh` line on the device: the script works out
  what the device has (shell, HTTP tool, OpenSSH or Dropbear, systemd / launchd / procd), creates the tunnel key,
  registers the device, authorizes Telepy, pins Telepy's host key, installs a service and waits until Telepy has
  logged in through the tunnel; `--check` runs the checks alone first. For everything else (Windows, Docker,
  appliances) a five-step wizard generates SSH, AutoSSH, systemd, PowerShell, Docker run and Docker Compose scripts.
- **The SSH port, or the web port when that is all that gets out.** Devices try the gateway's SSH port first and
  carry SSH inside a WebSocket on the web port when it is blocked. Every tunnel shows how it connects (SSH or SSH
  over WSS), and an installed device can be switched to the automatic way without dropping its tunnel. When your web
  name sits behind a proxy that only carries web traffic, give SSH a name of its own.
- **Tidy installs on the device.** Each tunnel's service gets a private install name; Telepy shows what is installed
  where, renames older installs and removes extra copies, all without taking the device offline.
- **Health at a glance.** Online / degraded / offline / never connected, per-hop latency, uptime and connection
  history, the device's public and LAN addresses with IP-change alerts, and daily device facts (OS, memory, disk,
  load, pending reboot) with warnings.
- **Organize hundreds of devices.** A dense list or cards, labels, pins, personal groups, and a search with filters
  such as `status:down`, `label:env=prod`, `os:openwrt` or `lastseen:>1d`.

### Work on a device

- **Web terminal** with tabs, Nerd Fonts, built-in and custom colour schemes, shells that survive a dropped
  connection (when you allow it), session recording, commands kept out of the device's shell history (if you want),
  and a **toolbox** of saved command snippets with variables.
- **File manager** over SFTP: drag-and-drop uploads, move / copy / rename / delete / permissions, zip downloads,
  image preview and an in-browser editor that never leaves half a file.
- **Remote desktop** in the browser: RDP and VNC through the tunnel (guacd), or RustDesk decoded in the tab, with
  sound, clipboard control, file transfer, multi-monitor cropping, and scaling and a resolution that follow your
  window.
- **Remote browser:** a real Chromium (KasmVNC) whose traffic leaves through the device, for web consoles that only
  answer on the device's network.
- **Network topology:** scan a device's LAN without installing anything, see vendors and open ports, then open a
  terminal or desktop on a LAN host through the device, or copy an `ssh -J` / `ProxyJump` setup.
- **From your own computer:** one command adds every device to `~/.ssh/config` (each device's host key checked too),
  the command sheet gives copy-ready `ssh -L` / `-R` / `-D` / `-J`, `scp` and `rsync` lines, and the **SSH config
  editor** shows what every host in your config really uses, fixes lines that never take effect and simplifies the
  file — every change checked against how ssh reads it (`telepy config tidy` does the same in a terminal).

### Teams and control

- **Sharing** with VIEW / EDIT / ADMIN permissions, per-account allow-lists, shares that expire, and access requests
  for temporary extra rights. Taking access away ends that person's open sessions at once.
- **Feature permissions and user groups:** decide who may use the terminal, files, desktop, LAN discovery, API
  tokens, MCP apps and more — for everyone, a group or one person.
- **Command rules:** block commands, hold them for approval or show a reminder — your own rules for the devices you
  manage, plus site-wide rules that admins may let people switch off on their own devices — in the web terminal and
  for MCP agents alike.
- **Live sessions:** see who is connected where, watch a terminal live (and hand over the keyboard), or end a session.
- **Sign-in security:** passkeys and authenticator apps, a second-factor check before sensitive devices, a list of
  your signed-in browsers, new-device alerts, and an optional discreet sign-in page.
- **Notifications:** in-app and desktop notifications per event, with site defaults admins can enforce and mutes per
  device; webhooks to Slack, Discord, Google Chat, Teams, Telegram, ntfy or your own service, personal or site-wide.
- **Audit:** tamper-evident logs (hash chains), terminal recordings and sign-in history.
- **Server health:** the admin section runs the server's own checks on the live server — configuration, keys,
  companion services, how visitors' addresses arrive, the audit chain — next to live numbers, and lets you acknowledge
  a known problem.

### Automate

- **`telepy` command line:** `telepy ls`, `telepy ssh web-01`, `telepy exec --label env=prod -- uptime`, `telepy cp`,
  live sessions, recordings, snippets, LAN hosts and scripted browsers; `ssh` / `scp` / `sftp` go through the web port,
  and `telepy update` keeps the CLI current.
- **REST API** with personal API tokens (scopes, tunnel limits, expiry, a call log) and a generated OpenAPI document.
- **MCP server** for AI agents (Claude Code, Cursor, …): approved per app through OAuth, every tool call audited,
  command rules and permissions applied.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/en/terminal.png" alt="Web terminal with the file manager"><br><sub><b>Web terminal + file manager</b> — tabs, the SFTP side panel and the latency of each hop.</sub></td>
    <td width="50%"><img src="./docs/screenshots/en/network.png" alt="Network topology"><br><sub><b>Network</b> — the LAN behind a device, scanned through its own sshd, with vendors and open ports.</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/en/desktop.png" alt="Remote desktop"><br><sub><b>Remote desktop</b> — a VNC desktop through the tunnel, with stream stats and screen selection.</sub></td>
    <td><img src="./docs/screenshots/en/browser.png" alt="Remote browser"><br><sub><b>Remote browser</b> — Chromium that goes online through the device.</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/en/create.png" alt="One-command device join"><br><sub><b>Add a device</b> — one command; the page shows what the script does and follows it until Telepy has logged in.</sub></td>
    <td><img src="./docs/screenshots/en/commands.png" alt="Command rules"><br><sub><b>Command rules</b> — your own and site-wide rules: block, approve, remind or allow, with a tester that shows who would be asked.</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/en/sessions.png" alt="Live sessions"><br><sub><b>Live sessions</b> — who is connected, from where; watch or end a session.</sub></td>
    <td><img src="./docs/screenshots/en/access.png" alt="Feature permissions"><br><sub><b>Feature permissions</b> — per person, per user group or for everyone.</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/en/sshconfig.png" alt="SSH config editor"><br><sub><b>SSH config editor</b> — paste a <code>~/.ssh/config</code>, see what each host uses and simplify it, checked against how ssh reads it.</sub></td>
    <td><img src="./docs/screenshots/en/health.png" alt="Server health"><br><sub><b>Server health</b> — the server's own checks, live numbers and the last 24 hours.</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/en/api.png" alt="API tokens"><br><sub><b>API</b> — personal tokens with scopes, tunnel limits and a per-token call summary.</sub></td>
    <td><img src="./docs/screenshots/en/activity.png" alt="Agent activity"><br><sub><b>Agent activity</b> — every MCP tool call, including commands waiting for approval.</sub></td>
  </tr>
</table>

## How it works

```
 your browser ──https──▶ Traefik ──▶ frontend (Next.js)
                            │
                            └──────▶ backend (Rust) ◀══ reverse SSH (outbound from the device) ══ device ── LAN hosts
                                       │   REST API · WebSockets · built-in SSH gateway · monitor
                                       ├──▶ kasm-browser (Chromium for remote browsing)
                                       └──▶ guacd (RDP / VNC)
```

A device runs `ssh -R 0:localhost:22 telepy@<server>` — straight to the gateway's SSH port, or inside a WebSocket on
the web port when only HTTPS gets out (the join script and the generated scripts set this up as a service). The backend's built-in SSH gateway accepts it, recognises the tunnel by its key and keeps the forward in
memory — nothing is bound on the host. Everything Telepy does on the device — terminal, files, desktop, remote
browser, LAN scans — opens a channel inside that one connection and logs in to the device's own sshd with that
tunnel's service key. The device needs no public IP and no inbound firewall rule; Telepy pins each device's host key,
and the device pins Telepy's.

More diagrams of what happens inside — joining a device, the terminal, files, remote desktop, sharing, command rules, keys, notifications, the CLI and server health — are in **[Telepy in pictures](./docs/visual-guide.md)**.

Telepy runs as five containers:

| Service        | Role                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `traefik`      | Reverse proxy: `/api/*`, `/ws/*` (devices' WebSocket way in too), `/mcp` and OAuth discovery go to the backend, everything else to the frontend |
| `frontend`     | Next.js web UI                                                                                        |
| `backend`      | One Rust process (axum + russh): REST API, WebSockets, the SSH gateway, monitoring, SQLite             |
| `kasm-browser` | KasmVNC + Chromium for remote browser sessions                                                        |
| `guacd`        | Apache Guacamole's RDP / VNC engine for remote desktops (internal network only)                       |

## Quick start

Requires Docker with the Compose plugin.

1. Create the environment file and set at least `SECRET_KEY`, `INTERNAL_API_TOKEN` and `SERVER_DOMAIN` (the public
   address behind an HTTPS proxy can go in `PUBLIC_URL` or, later, **Site settings → Server**):

   ```bash
   cp .env.example .env
   ```

2. Generate the gateway's host keys and the service key (re-running keeps existing keys — devices pin them):

   ```bash
   ./telepy.sh keygen
   ```

3. Build and start the stack, then check it:

   ```bash
   docker compose up -d --build
   ./telepy.sh doctor
   ```

4. Open `http://localhost:<WEB_SERVER_PORT>` (default `http://localhost:8787`) and sign in.

> [!NOTE]
> The **first account** becomes the administrator — whether it signs in with Google or is created with
> `./telepy.sh create-superuser`.

For production, put an HTTPS proxy in front of Traefik, set the public address, and make the gateway port
(`REVERSE_SERVER_SSH_PORT`) reachable for your devices. If the web name goes through a proxy that only carries web
traffic (Cloudflare's orange cloud, a CDN, an HTTP load balancer), give SSH a name that points straight at the server
under **Site settings → Server → SSH host** — or let devices use the web port. Visitors' addresses (sign-in history,
live sessions) come through X-Forwarded-For; by default every internal proxy in front of the backend is skipped
automatically. **Server health** in the admin section checks the whole setup and shows how the address of your own
request was worked out.

### Connect a device

- **Linux / macOS / OpenWrt:** **Tunnels → Create Tunnel → One command**, copy the command and run it on the device.
  The page follows each step and turns green once Telepy has logged in through the tunnel. Details:
  [docs/device-join.md](./docs/device-join.md).
- **Anything else (Windows, Docker, appliances):** **Step by step** — paste the device's public key, choose the
  login accounts, authorize Telepy's key, run one of the generated scripts, and verify the login.

When the tunnel is **Online**, the terminal, files, desktop and browser buttons on its card are ready.

## Configuration

These values live in `.env` because the stack needs them before it starts (see [`.env.example`](./.env.example) for
the full comments):

| Variable                  | Default     | Description                                                                 |
| ------------------------- | ----------- | --------------------------------------------------------------------------- |
| `PROJECT_NAME`            | `main`      | Suffix of container and network names (one per stack on a host)             |
| `DEBUG`                   | `false`     | Debug logging                                                               |
| `WEB_SERVER_PORT`         | `8787`      | Port Traefik publishes for the web UI, API and WebSockets                   |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | Port devices dial for their reverse SSH tunnel                              |
| `SERVER_DOMAIN`           | `localhost` | Host name of this server; written into scripts, SSH configs and pinned host keys |
| `SECRET_KEY`              | —           | Signs sign-ins and seals stored secrets; set a long random value before real use |
| `INTERNAL_API_TOKEN`      | —           | Secret between the backend and the kasm-browser container                  |
| `GEOIP_DIR` / `OUI_DIR`   | `/data/geoip` / `/data/oui` | Where the backend reads the IP geolocation databases and the NIC vendor list (paths inside the container; `./telepy.sh geoip` / `oui` fill them) |

The next ones are **optional**: each is also a field under **Site settings → Server**, which an admin can change in the
web without a restart. Leave the variable empty to manage it there; a value in `.env` wins and locks that field.

| Variable                      | Site setting                         | When empty                                              |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `PUBLIC_URL`                  | Public address                       | Taken from the request (OAuth issuer, passkey origin, join URL) |
| `SSH_SERVER_DOMAIN`           | SSH host                             | Same as `SERVER_DOMAIN`; set it when the web name goes through a web-only proxy |
| `SOCIAL_GOOGLE_CLIENT_ID`     | Google client ID                     | No Google sign-in                                       |
| `TRUSTED_PROXY_HOPS`          | Trusted proxies                      | `auto`: every internal address in X-Forwarded-For is a proxy |
| `CLIENT_IP_HEADER`            | Client IP header                     | None (Cloudflare's header is used when the request came through Cloudflare) |
| `GATEWAY_PROXY_PROTOCOL_FROM` | PROXY protocol sources for the SSH gateway | Off                                               |
| `DEVICE_PROBE`                | Daily device check                   | On: a daily read-only login for each device's addresses and facts |
| `KEEP_SHARED_SERVICE_KEY`     | Keep the shared service key on devices | Off                                                   |
| `LOG_LEVEL`                   | Log level                            | `info` (`debug` with `DEBUG=true`)                      |
| `OPENAPI_ENABLED`             | API reference                        | On (Swagger UI and the OpenAPI document, signed-in users only) |

Everything else — registration, sign-in lifetimes and two-factor requirements, remote browser and desktop limits,
MCP sessions, webhooks, notifications, terminal and command-rule defaults — is a site setting too, and users and
feature permissions are in the admin section (**Users & access**).

## Command line, API and MCP

**`telepy` CLI** — install a release build (macOS, Linux, Windows; every Telepy release carries one) or
`cargo install --locked --git https://github.com/NatLee/telepy telepy-cli`. The web's **CLI** page (sidebar
Developers → CLI) has the install command for your computer and examples filled in with your own tunnels:

```sh
telepy login https://telepy.example.com        # browser sign-in, or --token tpt_… from the API page
telepy ls                                      # tunnels with health, latency, accounts and labels
telepy ssh web-01                              # your system ssh through the tunnel, Telepy's host key pinned
telepy exec --label env=prod -- uptime         # many devices at once; command rules and audit apply
telepy cp ./app.conf web-01:/etc/app/
telepy config tidy                             # simplify ~/.ssh/config, checked against how ssh reads it
telepy api activity --follow                   # every call your API tokens make, as it happens
telepy update                                  # replace this binary with the latest release
```

In CI set `TELEPY_URL` and `TELEPY_TOKEN` instead of signing in. Details: [docs/cli.md](./docs/cli.md).

**REST API** — create a personal token on the **API** page; it lists every endpoint a token may call, with `curl`
examples. The OpenAPI document is at `/api/openapi.json` and Swagger UI at `/api/__hidden_swagger` (both need a
sign-in; `telepy-server openapi` prints the document).

**MCP** — point an MCP client at `https://<your-host>/mcp`, e.g.
`claude mcp add --transport http telepy https://<your-host>/mcp`. The first use opens an approval page where you pick
the permissions and tunnels; the **MCP** page has the setup for each client. Details: [docs/mcp.md](./docs/mcp.md).

## Maintenance

`./telepy.sh` (or `telepy.ps1` on Windows) wraps the day-to-day tasks:

| Sub-command        | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `keygen`           | Generate the gateway host keys and the backend service key (keeps existing ones) |
| `create-superuser` | Create an administrator account                                                   |
| `doctor`           | Check `.env`, containers, ports and the backend's configuration (exit 1 on a problem) |
| `geoip`            | Download offline IP geolocation (DB-IP Lite); re-run monthly                     |
| `oui`              | Download the IEEE vendor list so LAN hosts show their NIC vendor                 |
| `migration`        | Reconcile the database schema (also runs on every start)                         |
| `shell`            | Open a shell in the backend container                                            |
| `backend-debug`    | Recreate the backend container and follow its logs                               |

Upgrading is `git pull && docker compose up -d --build`; the database schema is reconciled on start.

## Documentation

- **[Telepy in pictures](./docs/visual-guide.md)** — the app's diagrams and a few recordings, feature by feature
- [All documentation](./docs/README.md) — every document below, in English, 繁體中文 and 日本語
- [The `telepy` command line and API tokens](./docs/cli.md)
- [MCP: AI agents on your devices](./docs/mcp.md)
- [Webhooks: events, formats and signatures](./docs/webhooks.md)
- [One-command device join (Linux, macOS, OpenWrt)](./docs/device-join.md)
- [Remote desktop (RDP / VNC / RustDesk)](./docs/remote-desktop.md)
- [Remote browser (KasmVNC)](./docs/remote-browser.md)
- [How the backend reaches devices](./docs/device-connections.md)
- [Latency measurement deep dive](./docs/latency-deep-dive.md)
- [Rust backend migration plan](./docs/rust-migration-plan.md) (Traditional Chinese) and [benchmark: Django vs Rust](./docs/benchmarks.md)
- [How the README screenshots are made](./docs/screenshots/README.md)
- [Articles](./docs/articles/) (Traditional Chinese)
- Release notes: [GitHub Releases](https://github.com/NatLee/telepy/releases)

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center"><a href="https://github.com/NatLee"><img src="https://avatars.githubusercontent.com/u/10178964?v=3?s=100" width="100px;" alt="Nat Lee"/><br /><sub><b>Nat Lee</b></sub></a></td>
      <td align="center"><a href="https://github.com/h-alice"><img src="https://avatars.githubusercontent.com/u/16372174?v=3?s=100" width="100px;" alt="H. Alice"/><br /><sub><b>H. Alice</b></sub></a></td>
      <td align="center"><a href="https://github.com/boris-lok"><img src="https://avatars.githubusercontent.com/u/77889460?v=3?s=100" width="100px;" alt="Boris Lok"/><br /><sub><b>Boris Lok</b></sub></a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

Telepy is licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0). If you run a modified
Telepy as a service for other people, you must offer them its source code. If that does not fit your use, a
commercial license is available — contact [@NatLee](https://github.com/NatLee).

Versions released before October 2026 were MIT-licensed; see [NOTICE](./NOTICE). Contributions are made under the
[Contributor License Agreement](./CONTRIBUTING.md#contributor-license-agreement).
