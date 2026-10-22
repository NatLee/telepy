# CLAUDE.md — Telepy

## Project Overview

Telepy is a full-stack web application for managing reverse SSH tunnels. It provides a web UI for creating/managing tunnels, a WebSocket-based terminal console, SFTP file management, remote browser sessions (KasmVNC, see `docs/remote-browser.md`), and tunnel sharing with permission controls.

The backend is a single Rust process (`src/backend-api/`, binary `telepy-server`) that serves the REST API and WebSockets **and terminates the devices' reverse SSH tunnels itself** (in-process SSH gateway). The migration from the previous Django backend is documented in `docs/rust-migration-plan.md`; the API/WebSocket contract is byte-compatible with it, so the frontend did not change.

## Tech Stack

- **Backend:** Rust (edition 2021) / axum 0.8 + tokio / sqlx (SQLite) / russh (SSH server for the gateway, SSH+SFTP client to devices) / jsonwebtoken / tower-http
- **Frontend:** Next.js 16 (App Router) / TypeScript / Tailwind CSS 4 / Radix UI / xterm.js
- **Database:** SQLite3 (`/data/db.sqlite3`, Django-era table names kept)
- **Auth:** Google OAuth2 (id_token verified against Google JWKS) + JWT (simplejwt-compatible HS256; `SECRET_KEY` env, legacy default with a startup warning)
- **Infra:** Docker Compose / Traefik v3 (reverse proxy)
- **Browser:** KasmVNC + Chromium in the `kasm-browser` container (per-session Xkasmvnc, WS↔WS relay through the backend; the frontend uses the vendored KasmVNC noVNC fork in `src/frontend/src/vendor/kasm-novnc/`)

## Project Structure

```
src/
  backend-api/        # Rust backend (crate telepy-server)
    src/
      main.rs         # CLI: serve (default) | migrate | create-superuser | seed-service-key
      config.rs       # env → Config (same variable names as before: DEBUG, SECRET_KEY, REVERSE_SERVER_SSH_PORT, …)
      app.rs          # axum Router: REST (+compression) merged with /ws routes, CORS mirror, tracing
      db/             # sqlx over the Django-named tables; schema.rs = idempotent DDL (creates missing tables/columns, never alters existing)
      auth/           # jwt.rs, password.rs (Django pbkdf2_sha256), google.rs (JWKS), extractor.rs (Bearer → AuthUser)
      api/            # REST handlers per former Django app: auth, tunnels, usernames, user_keys, reverse_keys, scripts, sharing, users, site_settings, logs, sftp, remote_browser
      ws/             # WebSockets: auth.rs (first-message JWT), notifications, tunnel_connection, terminal (PTY), filemanager (SFTP), remote_browser (KasmVNC relay)
      gateway/        # in-process SSH server: pubkey auth from DB, tcpip-forward → 127.0.0.1:<port> loopback bridge, direct-tcpip, status + latency probes, sshd-style log
      monitor/        # StatusState (listening ports / latency), ports.rs (debounce + latency throttle), runner.rs (5 s cycle → notifications)
      hub.rs          # in-process notification hub (per-user / per-tunnel broadcast; replaced the Redis channel layer)
      ssh/            # process.rs (OpenSSH client argv + PTY spawn), device.rs (russh client to a device, in-process via the gateway), pool.rs (one shared connection per tunnel + OS account)
      sftp/           # path resolution, structured listing, zip download, upload
      remote_browser/ # ssh -D SOCKS session store, kasm session-manager client, reaper
      scripts/        # connection-script / ssh-config rendering ($var substitution, templates/)
      permissions.rs  # VIEW/EDIT/ADMIN hierarchy, allowed target usernames
      oauth/          # OAuth 2.1 authorization server logic for MCP clients (scopes, PKCE, redirect URIs, metadata)
      mcp/            # MCP server at /mcp (rmcp, stateless Streamable HTTP): tools + bearer middleware
      ai/             # SSH sessions opened by AI agents: registry, exec/SFTP, expiry, reaper
    templates/        # ssh / autossh / systemd / PowerShell / docker scripts, ssh_config
    tests/            # integration tests (router in-process, real listener for WS, real OpenSSH client for the gateway); common/lab.rs = reusable SSH topology
    Dockerfile        # multi-stage build → debian-slim + openssh-client
  frontend/           # Next.js app (unchanged by the backend rewrite)
    src/app/          # Pages: login, first-login, tunnels (create/index/terminal/settings/logs/keys/cheatsheet/network/mcp/activity); root page.tsx redirects by auth state
    src/components/   # UI components (Shadcn-style + Radix)
    src/fonts/        # Local font files: huninn unicode-range subsets (src/app/huninn.css) + 0xProto (next/font/local)
    src/hooks/        # Custom React hooks (WebSocket, notifications, etc.)
    src/lib/          # API client, auth, WebSocket, i18n, utilities
    src/locales/      # i18n dictionaries: en.ts (key source of truth), zh-TW.ts, ja.ts
    src/types/        # TypeScript type definitions
  configs/traefik/    # Traefik static + dynamic config
docker/kasm-browser/  # KasmVNC + Chromium image and its session-manager
ssh/                  # backend_ssh_key (service key + ssh config), ssh_host_keys (gateway host keys; generated, git-ignored)
dev-scripts/          # Helper scripts behind telepy.sh / telepy.ps1
docs/                 # remote-browser.md, latency-deep-dive.md, device-connections.md, rust-migration-plan.md, articles/
```

## Development Commands

### Docker (primary workflow)

```bash
docker compose up -d --build            # Start all services
docker compose up -d --build backend    # Rebuild the Rust backend only
docker compose up -d --build frontend
```

### CLI wrapper (`telepy.sh` / `telepy.ps1`)

```bash
./telepy.sh keygen            # Generate gateway host keys + backend service key
./telepy.sh create-superuser  # Create an admin account (first user is a superuser anyway)
./telepy.sh shell             # Shell into the backend container
./telepy.sh migration         # Reconcile the DB schema (runs automatically on start)
./telepy.sh backend-debug     # Recreate the backend container and follow its logs
```

### Backend (local, needs rustup)

```bash
cd src/backend-api
cargo test                    # unit + integration tests (needs ssh/ssh-keygen and, for the SFTP test, a local sftp-server; both skip otherwise)
cargo run -- serve            # DATA_DIR / LOG_ROOT default to ./data ./logs; gateway only when GATEWAY_HOST_KEYS_DIR points at host keys
cargo run -- create-superuser --username admin --password 1234
cargo run -- openapi > openapi.json   # dump the OpenAPI document (no DB / server / login needed)
```

### Frontend

```bash
cd src/frontend
npm install
npm run dev    # Dev server (port 3000)
npm run build  # Production build
```

## Environment Setup

Copy `.env.example` to `.env` and configure:

- `PROJECT_NAME` — container name suffix (default: `main`)
- `DEBUG` — debug logging (default: `false`); `LOG_LEVEL` overrides the level
- `SECRET_KEY` — JWT signing key (empty = legacy default + warning; set in production)
- `WEB_SERVER_PORT` — Traefik exposed port (default: `8787`)
- `REVERSE_SERVER_SSH_PORT` — port devices connect their reverse SSH to (default: `24242`, published to the gateway's 2222)
- `SOCIAL_GOOGLE_CLIENT_ID` — Google OAuth client ID
- `SERVER_DOMAIN` — server hostname (default: `localhost`)
- `INTERNAL_API_TOKEN` — secret for backend → kasm-browser session-manager calls

## Architecture Notes

- **Services:** 4 containers via Docker Compose: Traefik, frontend, backend, kasm-browser. No Redis, no separate SSH container, no supervisor.
- **Routing:** Traefik routes `/api/*`, `/ws/*`, and a fixed set of `/tunnels/{share,unshare,shared-users,available-users,update-permission,server}` paths to the backend (`backend:8000`); everything else to the frontend. Traefik applies a `compress` middleware to HTTP routers (not `/ws`); the backend also compresses REST responses.
- **SSH gateway (`gateway/`):** the backend listens on 2222 (published as `REVERSE_SERVER_SSH_PORT`) with the host keys from `ssh/ssh_host_keys`. Only public-key auth (tunnel / user keys from the DB) and `tcpip-forward` are accepted — the service key is deliberately **not** accepted (the backend reaches devices over loopback; that key sits in every device's `authorized_keys`), a tunnel key may only forward its own port and a user key only ports of tunnels the user owns; every forward binds `127.0.0.1:<reverse_port>` inside the backend container and bridges to a `forwarded-tcpip` channel, so the OpenSSH client (terminal, `ssh -D`) reaches the device in a single hop; russh (SFTP, file manager, AI sessions) skips TCP and opens the forwarded-tcpip channel in-process (`Gateway::open_stream`), and SFTP / the file manager share one connection per (tunnel, OS account) through `ssh::pool` (lease = channel, ≤ 8 per connection, learns a lower device MaxSessions, idle 5 min). See `docs/device-connections.md`. `direct-tcpip` serves the generated ssh config's `ProxyCommand ssh -W` for user keys. Shell/exec/pty are refused. Device-side scripts are unchanged.
- **Device-side scripts (`scripts/`, `templates/`):** rendered with Python `string.Template.safe_substitute` semantics (unknown `$names` survive, so shell variables in templates are fine). The Docker flavours use `jnovack/autossh` (env-driven, key mounted at `/id_rsa`, defaults to `~/.ssh/id_rsa`) and reach the device's sshd through `host.docker.internal` (`extra_hosts`/`--add-host host-gateway`, Docker 20.10+ / Docker Desktop); the compose one-liner needs `-f telepy-docker-compose.yml`. Scripts only ever *append* the service key to `authorized_keys`. There is no public `alpine/autossh` image — don't bring it back.
- **Status / latency:** forward registration and release update `StatusState` immediately; a banner round-trip through a forwarded channel every 15 s measures RTT. `monitor/runner.rs` runs the 5 s cycle (debounce FLAP_THRESHOLD 2, latency throttle 5 ms / 6-cycle keep-alive) and emits the `UPDATE-TUNNEL-*` notifications through the in-process hub.
- **WebSocket:** first frame `{type:"auth", token, …}` within 10 s; close codes 4000/4001 (auth), 4002/4003/4004/4005/4006 (terminal/file manager), 4403/4404/4011/4013 (remote browser). Terminal pong is a **binary** frame; the other sockets answer `{"type":"pong"}`.
- **Terminal:** `openpty` + OpenSSH client (`ControlMaster=auto`, `ControlPersist=600`, `ControlPath=/tmp/ssh_term_%r@%h:%p`); on disconnect only the direct child gets SIGTERM → SIGKILL (never killpg — the mux master would die and kick every other tab).
- **Permissions:** hierarchical tunnel access — VIEW / EDIT / ADMIN — in `permissions.rs`. Target OS accounts (usernames) are managed only by the owner and ADMIN sharees (unique per tunnel); every other sharee may use **exactly** the allow-list the owner/ADMIN set (empty = none — creating a row never grants it). `permissions::allowed_usernames` is the single gate for terminal, files, SFTP, remote browser, scripts and MCP: the device can't tell Telepy users apart (all log in with the one service key), so this list is the only boundary.
- **TLS / deployment:** prod sits behind an upstream TLS-terminating proxy that forwards `http` to Traefik `:80`; Traefik keeps the upstream `X-Forwarded-*` headers (`forwardedHeaders.insecure: true`), and the backend uses `X-Forwarded-Proto` / `X-Forwarded-Host` for the one-time script URL. If Traefik `:80` is reachable from untrusted networks, switch `insecure: true` → `trustedIPs`.
- **Startup / health:** the backend reconciles the schema, seeds the `web-service` key from `/root/.ssh/id_rsa.pub`, stops orphaned remote-browser sessions, starts the gateway and the monitor, then listens. `GET /api/auth/setup-status` is the public health endpoint used by the compose `healthcheck` and Traefik's `healthCheck`.
- **API docs (`api/doc.rs`, `api/schemas.rs`):** every REST handler carries a `#[utoipa::path]` attribute and each `api/*::router()` is a `utoipa_axum::OpenApiRouter` (`routes!`), so the OpenAPI document is generated from the real routes; `app::openapi()` returns it without state. Swagger UI is at `/api/__hidden_swagger`, the spec at `/api/openapi.json`; **both need a login** — the spec takes a Bearer token (`AuthUser`), the page is a same-origin shell whose initializer verifies/refreshes the frontend's localStorage token and redirects to `/login` otherwise (`OPENAPI_ENABLED=false` removes them). Handlers still return `serde_json::Value`, so the `schemas.rs` structs are documentation only — **when you change a response/request shape, update the matching struct** (and `tests/openapi.rs` asserts the key paths/security). A PUT+PATCH pair needs two handler fns (`update` + `replace`), one per `#[utoipa::path]`.
- **OAuth 2.1 (MCP connectors, `oauth/` + `api/oauth.rs` + `db/oauth.rs` + `auth/mcp.rs`):** Telepy is its own authorization server. Discovery at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource[/mcp]` (Traefik routes `/.well-known/oauth-*` to the backend); `POST /api/oauth/register` (RFC 7591, public); the authorization endpoint is the **frontend** page `/oauth/authorize`, which calls `GET/POST /api/oauth/authorize` with the web JWT (the web login lives in localStorage, so the backend cannot see it on a redirect); the page (`app/oauth/authorize/page.tsx` + `hooks/useOAuthConsent.ts`) forwards the client's query verbatim, sends a logged-out user to `/login?next=<this url>` (`safeNextPath()` in `useLoginPage.ts` only accepts same-origin paths), shows the client name **and** `redirect_host` (registration is open, names are attacker-controlled), lets the user drop scopes / restrict tunnels, and `window.location.assign`s the returned `redirect_to`; errors without `redirect_to` are shown without redirecting. `next.config.ts` sends `X-Frame-Options: DENY` + `frame-ancestors 'none'` for `/oauth/*`. Connected apps (revoke, `components/layout/ConnectedApps.tsx`) appear in the preferences modal's Connected apps tab **and** on the **MCP page** (`/tunnels/mcp`, `hooks/useMcpPage.ts`; sidebar section "AI" next to AI activity): endpoint URL taken from the RFC 9728 `resource` (so it reflects `PUBLIC_URL`; falls back to origin + `/mcp`; dev proxies `/.well-known/*`), copy-ready setup per client, scope → tool table, session rules; the Settings page has an "AI access" tab (`?tab=ai`) with the `ai_*` site settings and the MCP endpoint; the **AI activity page** (`/tunnels/activity`, `hooks/useAiActivityPage.ts`) lists open AI sessions from `GET /api/ai/sessions` (close = `DELETE`), the audit log from `GET /api/ai/activity` (admins get tunnel/user filters), and refreshes on the `AI-SESSION-OPENED` / `AI-SESSION-CLOSED` notifications; the tunnels page toasts those only when `by` is someone else (an agent on a tunnel you own). Tool and close-reason names are translated via `activity.tool.*` / `activity.reason.*`; `POST /api/oauth/token` (authorization_code + PKCE S256 only, refresh_token rotated on every use, compare-and-swap), `POST /api/oauth/revoke`, `GET/DELETE /api/oauth/grants` (Connected apps). Authorization codes live in memory (`tokens.rs`, 10 min, single use); grants in `telepy_oauth_grant` (refresh token SHA-256 only, optional tunnel restriction, scopes `tunnels:read` / `ssh:exec` / `ssh:files`). Access tokens are 1 h JWTs with `token_type: "mcp_access"` — not accepted by the REST extractor, and web tokens are not accepted by `auth::mcp::resolve`, which also re-checks the grant and the user on every request (revocation is immediate). Issuer = `PUBLIC_URL`, else derived from X-Forwarded-Proto/Host.
- **MCP server + AI sessions (`mcp/`, `ai/`, `api/ai.rs`, `db/ai_audit.rs`; user doc `docs/mcp.md`):** `POST /mcp` is rmcp's Streamable HTTP service in stateless mode (`legacy_session_mode = false`, JSON responses, `NeverSessionManager`, host check disabled because every request needs a bearer) behind `require_token`, which calls `auth::mcp::resolve` and answers 401 + `WWW-Authenticate: Bearer resource_metadata=…` (Traefik router `backend-mcp`, no compression; rmcp rejects requests without a `Host` header). The `McpPrincipal` reaches tools through `Extension<http::request::Parts>`. Tools: `list_tunnels`, `tunnel_status`, `ssh_session_open/exec/list/close`, `sftp_list/read/write`; scope checks return a tool error (`isError`) that tells the agent what to ask for. An AI session is one russh `DeviceConn` reused by every command (exec channel per command, ≤ 4 at once, no PTY), owned by (user, grant) — MCP 2026-07-28 has no transport sessions — and closed by the agent, the web (`DELETE /api/ai/sessions/{id}`: user, tunnel owner, admin), idle / max-lifetime (site settings `ai_session_idle_timeout` 600, `ai_session_max_lifetime` 7200, `ai_max_sessions_per_user` 3), device offline, grant revocation (immediately, from `revoke_grant_by_id`) or lost permission/username (reaper every 30 s, `ai::reap_once`). Opening/closing notifies the user and the tunnel owner (`AI-SESSION-OPENED` / `AI-SESSION-CLOSED`); every tool call is a `telepy_ai_audit_event` row (100k cap) served by `GET /api/ai/activity` (admins all; others own + own tunnels). Tests: `tests/mcp_api.rs` runs a fake device sshd (russh server: `sh -c` exec + local `sftp-server`).
- **Create wizard (`/tunnels/create`, `hooks/useCreateTunnelWizard.ts`, `components/tunnels/CreateWizardSteps/`, pure helpers in `lib/tunnelSetup.ts`):** five steps — Device (paste the device public key; private keys are rejected client-side, `/api/reverse/create/key/duplicate/{token}` runs before the create for friendly field errors; the tunnel is created on submit and step 1 is read-only afterwards, so Back never creates a second one) → Login accounts (target usernames) → Authorize Telepy (one append-only, idempotent `authorized_keys` command for Linux/macOS or PowerShell built by `authorizeKeysCommand`; service key always included, user keys optional) → Connect (six script kinds, one-time `curl | bash` URL from `/tunnels/server/script/one-time/token`, live status from `/ws/tunnel_connection/{id}/`) → Verify (a real login per account through the tunnel via `GET /api/sftp/shell/{id}/{username}`; `classifyLoginError` maps "device auth" → key not in authorized_keys, "connect to"/timeout → tunnel down). `SetupDiagram` is a live you ⇄ Telepy ⇄ device topology that follows the step and the real connection state; `WhyPanel` explains each step. All copy is under `wizard.*`.
- **Command sheet (`/tunnels/cheatsheet?tunnel=<id>`):** copy-ready `ssh -L/-R/-D/-J`, `scp`/`rsync` commands per tunnel, built by the pure `lib/forwardRecipes.ts` (each command = segments with an i18n explanation key plus a short label via `SHORT_LABEL`, which drive the coloured command, hover text and the explainshell-style breakdown). The page is three steps — task cards with mini illustrations, a fill-in-the-blank sentence, one command — around an illustrated `TunnelScene` that keeps the same topology for every recipe (your computer ═ tunnel via Telepy ═ device ─ target); breakdown, options, all commands and troubleshooting are collapsible, and first-time setup is the `SetupGuide` dialog. Every forward rides an SSH session to the device itself (the gateway only allows `direct-tcpip` to `localhost:<reverse_port>`). Aliases come from `GET /tunnels/server/config/{id}`, which besides `config`/`usernames` returns `server {alias, host, port}`, `hosts [{alias, username, username_id}]` and `reverse_port` — keep them in sync with the rendered stanzas.
- **Two-factor sign-in (`mfa/`, `mfa/passkey.rs`, `api/mfa.rs`, `db/mfa.rs`; tests `tests/mfa_api.rs`):** an account has 2FA when it has an enabled TOTP or at least one passkey. `/api/auth/token` and `/api/auth/google/token` then answer `{mfa_required, mfa_token, methods}` instead of tokens (`api::mfa::complete_login`); `POST /api/auth/mfa/verify` finishes with `totp` / `recovery_code` / `passkey` (options from `/api/auth/mfa/passkey/options`). Passwordless: `POST /api/auth/passkey/options` (discoverable, `mediation: conditional`) → `POST /api/auth/passkey/login`. Management under `/api/auth/mfa*` and `/api/auth/passkeys*`; adding/removing a factor and regenerating recovery codes need a `reauth` proof once the account has any factor (`require_reauth`, 403 `code: reauth_required`), and so does approving an MCP app on the OAuth consent page. Admin reset: `DELETE /api/user/users/{id}/mfa`. TOTP = RFC 6238 SHA-1/6/30 s, ±1 step, last step stored (no replay, compare-and-set); the secret is AES-256-GCM-sealed with a key derived from `SECRET_KEY` (rotating it breaks existing TOTP — users fall back to passkeys / recovery codes / admin reset). Recovery codes: 10, SHA-256 only, issued with the first factor and cleared with the last. Lockout: 10 failures per user per 15 min (a success resets it), 5 tries per `mfa_token`, challenges and WebAuthn ceremonies live in memory for 5 min and are single use. Passkeys use `webauthn-rs` 0.5 (links OpenSSL; `libssl-dev` / `libssl3` in the Dockerfile), RP ID = host of `PUBLIC_URL` / forwarded headers (`localhost` allows any port; IP addresses are rejected because browsers refuse them); credentials are stored as the serialised `Passkey` with the counter updated on use. Error bodies are `{error, code}`. Frontend: `lib/webauthn.ts` converts the webauthn-rs JSON options to/from `navigator.credentials` (no library; registration asks for `residentKey: "preferred"` so autofill can find the passkey), `lib/mfa.ts` maps error codes to `security.*` keys, `hooks/useReauth.tsx` + `components/auth/ReauthDialog.tsx` are the promise-based "confirm it's you" step used by `components/layout/SecuritySettings.tsx` (the Security tab of the preferences modal) and the OAuth consent page, `RecoveryCodesDialog` shows codes once; the login page (`hooks/useLoginPage.ts`) handles `mfa_required`, the passkey button and conditional-UI autofill (`autocomplete="username webauthn"`, aborted before any modal passkey prompt); admins reset a user from Settings → Users → Manage.
- **LAN discovery + jump hosts (#20; `lan/`, `lan/scan.rs`, `api/lan.rs`, `db/lan.rs`; tests `tests/lan_api.rs` on the SSH lab):** agentless — the scan connects to the device (`ssh::device::connect`, its own connection, not the pool) and every probe is a `direct-tcpip` channel the **device's sshd** opens (needs `AllowTcpForwarding`). Steps: detect the device's IPv4 networks (`ip -o -4 addr` → `ifconfig` → PowerShell `Get-NetIPAddress`, virtual interfaces skipped, networks larger than /22 narrowed to the device's /24) or use the given private CIDRs (≤ 1024 addresses; never public ranges); probe the first port on every address (48 in flight, 1.5 s each, which also primes ARP); read the neighbour table (`ip neigh` / `arp -an` / `Get-NetNeighbor`) for live hosts without open ports; probe the other ports on live hosts only; read a banner on every open port (SSH is recognised on any port); names via `getent hosts`. Parsers are pure functions with unit tests (`lan/mod.rs`). Results upsert into `telepy_lan_host` (unique per tunnel + address; label / username / ssh_port / source are never overwritten by a scan; deleted with the tunnel). One scan per tunnel at a time (`LanScans`, in memory). Scanning needs owner or ADMIN plus the site switch `lan_scan_enabled`; VIEW sees hosts, EDIT edits them. Each scan writes a `lan_scan` gateway event (the tunnel's Logs) and sends `LAN-SCAN-PROGRESS` / `LAN-SCAN-DONE` to the scanner and `UPDATED-LAN-HOSTS` to the tunnel audience. API: `/api/reverse/server/{id}/lan/{hosts,scan}`, `/api/reverse/lan/topology`; MCP tools `lan_hosts` (`tunnels:read`) and `lan_scan` (new scope `network:scan`). Errors are `{error, code}`. **Web terminal to a LAN host:** the terminal auth frame may add `lan_host_id` (+ optional `lan_username`, default = the host's `username`); access is the device terminal's (VIEW + allowed device username, which is the jump account), the host must belong to the tunnel (else 4004), and the login must pass `ssh::process::valid_login` (`[A-Za-z0-9._-]{1,64}`, no leading `-`; else 4003; the API enforces the same rule on `username`). `lan_terminal_args` runs `ssh -o ProxyCommand='<ssh> … -W %h:%p -p <reverse_port> <device_user>@<target>'` (every token shell-quoted) without ControlMaster; the last hop allows publickey, keyboard-interactive and password, so prompts appear in the web terminal. Each open writes a `lan_terminal` gateway event. Frontend: `/tunnels/terminal?serverId=…&lanHost=<id>[&lanUser=…]` (`getTerminalPageUrl(t, {lanHost, lanUser})`). **Network page** (`/tunnels/network[?tunnel=<id>]`, nav "Network", tunnel actions "LAN hosts"; `hooks/useNetworkPage.ts`, `components/network/` — `TopologyTree` (Telepy → devices → hosts as a CSS hairline tree: hosts under the device on phones, to its right from `lg`; solid = online, dashed = offline), `HostDialog` (Connect: web terminal, no-config `ssh -J` one-liner, `ProxyJump <device alias>` stanza, command-sheet deep link; Details; Edit/remove), `ScanDialog`, `AddHostDialog`; pure helpers in `lib/lanConnect.ts`, types in `types/lan.ts`): data from `/api/reverse/lan/topology`; `POST/GET …/lan/scan` return the bare scan status; progress comes from `LAN-SCAN-PROGRESS` with a 3 s poll while a scan runs, and `LAN-SCAN-DONE` / `UPDATED-LAN-HOSTS` refetch; only your own finished scans toast. The device's own addresses are never probed, and discovery is "first port open or in the neighbour table", so a loopback-only test device needs the first port to be open. The command sheet accepts `?recipe=<id>` plus that recipe's field names (e.g. `recipe=jump&lanHost=…&lanUser=…&lanPort=…`).
- **One-command device join (#14; `join/mod.rs`, `api/join.rs`, `templates/join_install.sh`; tests `tests/join_api.rs` on the SSH lab):** the web mints a ticket with `POST /api/reverse/join` (`{name?, key_list?}` → `{id, token, command, command_no_sudo, install_url, expires_at, phase}`; owner-only `GET/DELETE /api/reverse/join/{id}`; ≤ 10 open per user, 30 min). Tickets live in memory (`state.join`, token `tpj_…` stored as SHA-256, lost on restart). The device runs `curl -fsSL <base>/api/join/install.sh | sudo sh -s -- --token …` (base = `PUBLIC_URL`, else X-Forwarded-*): a POSIX script (everything inside `main()` so a truncated download does nothing; the only template key is `server_url`, and `$$` must never appear because `safe_substitute` turns it into `$`) that checks the local sshd with `ssh-keyscan`, creates `~/.ssh/telepy_tunnel_ed25519`, registers via public `POST /api/join/{token}` (single use; a failed registration releases the ticket; the same device key again = rejoin the same tunnel, someone else's key = 409; name = web name, else `--name`, else hostname with `-2`… suffixes since names are globally unique; the login account becomes the default username), appends the service key to `authorized_keys`, pins the gateway host keys (`Gateway::host_public_keys`) in `~/.ssh/telepy_known_hosts` with `HostKeyAlias=telepy-<host>-<port>` + `StrictHostKeyChecking=yes`, installs `telepy-tunnel-<id>` (root + systemd → system unit with `User=`; systemd --user + linger warning; macOS → LaunchDaemon/LaunchAgent; else a `nohup` loop + `@reboot` crontab), writes `~/.ssh/telepy-uninstall-<id>.sh`, and polls public `GET /api/join/{token}/status` until the backend's own test login (`ssh::device::connect`, 25 s) says `verified` or `failed` (with an explanation). Device-facing answers are `KEY=value` text (no jq). Phases waiting → registered → connected → verified | failed are pushed to the owner as `JOIN-UPDATED` and logged as `join` gateway events. Tested for real in Debian containers (root, non-root, rejoin, systemd, uninstall). **Frontend:** the create page (`/tunnels/create`) has a "One command (Linux / macOS)" | "Step by step" switch (one command is the default; the choice is kept in localStorage `telepy.createMode` and read with `useSyncExternalStore`); `hooks/useDeviceJoin.ts` mints / cancels the ticket, polls `GET /api/reverse/join/{id}` every 2 s plus `JOIN-UPDATED`, and counts down `expires_at`; `components/tunnels/JoinPanel.tsx` shows the command (sudo / no-sudo), what it does, the four-step progress and the result, and drives the wizard's `SetupDiagram` (waiting = step 1, registered = 4, connected/verified = 5). Copy is under `join.*`.
- **Device key lists (`device_keys/`, `api/device_keys.rs`, `db/device_keys.rs`; tests `tests/device_keys.rs`):** Telepy installs users' public keys into a device account's `~/.ssh/authorized_keys` itself, over russh + SFTP with the service key (connections borrowed from `ssh::pool`). Each tunnel has a key list (`telepy_device_key`): anyone with access may add **their own** keys (`POST /api/reverse/server/{id}/device-keys`); a key goes into exactly the OS accounts its owner may use there (`permissions::allowed_usernames`, the same gate as the terminal), so unshare (entries deleted), a smaller allow-list, a permission change, a deleted username or a deleted/changed user key all remove it from the device. Desired state (list × allowed accounts) minus what Telepy installed (`telepy_device_key_installed`) is reconciled by `device_keys::run` (kicks from those handlers + a 15 s tick that also catches devices coming back online; failed accounts retry after 2 min) or `POST …/device-keys/sync` (forced re-read; 409 `device_offline`). Writes are tmp file + `posix-rename@openssh.com` (never a half-written file — the service key lives there; existing mode kept, new files 0600, symlinks followed); Telepy only ever removes keys it installed and never a service key. Owners / ADMIN sharees see every entry and pending removals and can audit live (`GET …/authorized-keys`: each line classified service / managed / telepy_user / unknown / invalid) and remove a key that is not in the list (`POST …/authorized-keys/remove`; 400 `service_key`, 409 `in_key_list`). `GET /api/reverse/user/keys/devices` is the keys-page matrix (my keys × devices I can use). Tunnel creation accepts `key_list: "mine" | "empty"` (`mine` copies all of the creator's keys into the list once). User keys are parsed with russh on create/update (reject garbage, DSA, RSA < 2048, the same key under another comment, tunnel or service keys) and serialised with `fingerprint` / `key_type` / `bits` / `comment`; the gateway records `last_used_at` / `last_used_ip` on every user-key login. The lab sshd also honours `<home>/<account>/.ssh/authorized_keys` once `Machine::account_home(account)` exists. Frontend: `/tunnels/keys` (`hooks/useKeysPage.ts`, `components/keys/*`) shows key cards (fingerprint, type, last use, devices), the collapsible "how device key lists work" explainer (`KeyListExplainer`, hidden state in localStorage `telepy.keysExplainer`), the my-keys × devices matrix (tick = on that device's list, per-account chips installed / pending / error) and the per-device panel `DeviceKeysModal` (`hooks/useDeviceKeys.ts`; `?device=<id>`, linked from the tunnel menu's "Device keys"): list + live audit tab for owner / ADMIN. `lib/sshKeys.ts` parses keys client-side for the add dialog's live preview (type, bits, SHA256 fingerprint via WebCrypto); error codes map to `keys.err.*` in `lib/deviceKeyErrors.ts`. The create wizard's step 1 sends `key_list` (default `mine` when you have keys); step 3 then leaves personal keys out of the authorized_keys command.
- **Tunnels list data:** `GET /api/reverse/server/dashboard` returns `{tunnels, ports, latency}` in one round-trip; the list serializer uses a precomputed permission map + share counts (no per-row queries).
- **Device public IP (`endpoint`):** every list item (`/keys`, `/dashboard`; not the single-tunnel retrieve) carries `endpoint {ip, live, connected_at, last_seen_at}` = the TCP source the gateway saw. Live values come from `StatusState::endpoints()` (set in the gateway's `publish_status` from `ConnInfo`); the last known one is one overwritten row per tunnel in `telepy_tunnel_endpoint` (written on forward register / release, deleted with the tunnel). **Visibility follows device access, not the VIEW/EDIT label** (`permissions::can_see_endpoint`): owner, ADMIN, superuser, or a sharee with ≥1 allowed username — anyone who can open a shell there can `curl ifconfig.me` anyway; status-only sharees get `null`. Never put it in the unscoped `ports`/`latency` maps. Behind an L4 proxy (or Docker userland-proxy / Docker Desktop) the gateway sees the proxy's address. The frontend (`TunnelEndpointChip`) reloads the list quietly after `UPDATE-TUNNEL-STATUS`.
- **Logging:** `tracing` → stdout + daily rolling `/logs/telepy.log` and `/logs/error.log` (a bare `LOG_LEVEL=debug` silences sqlx/hyper/russh internals; pass a full EnvFilter directive to override). Gateway events (accepted / forward / disconnect / refused …) go to the `telepy_gateway_event` table (capped at 100k rows and 90 days — rows carry source IPs) and are also appended sshd-style to `/logs/ssh-gateway.log`; `/api/log/ssh/events?limit=&tunnel_id=` returns them as JSON (what the Logs page uses; oldest first) and `/api/log/ssh` renders the last 500 as sshd-style text (200 with an empty string when there are none). **Both are scoped:** admins (`is_superuser`) see every event, other users only events of tunnels they own or that are shared with them (tunnel-less events such as `listening` are admin-only; a foreign `tunnel_id` is a 404). The Logs page (`/tunnels/logs?tunnel=<id>`) keeps the tunnel filter in the URL and the tunnel actions menu deep-links to it; event badges key off the structured `event` field (`logs.event.*` i18n keys), not message text.
- **Compatibility rules:** JSON shapes, status codes and error strings mirror the former DRF views (the frontend parses `{detail}` / `{error}` / `{field: [...]}`); keep them unless the frontend is changed in the same PR. DB datetimes are stored as naive UTC with microseconds (Django format) and serialised as `+08:00` ISO (DRF field) or `…Z` (DRF encoder) exactly where the old code did.

## Fonts

- **Sans (CJK + Latin):** jf-openhuninn 2.1 / 粉圓 (justfont, SIL OFL; source `src/frontend/src/fonts/jf-openhuninn-2.1.ttf`) — the whole UI font, family name `"jf-openhuninn"` in `--font-sans`
- **Terminal / Monospace:** 0xProto Nerd Font (`src/frontend/src/fonts/0xProtoNerdFont-Regular.woff2`) — `font-mono` and the xterm.js terminal font
- **Huninn is split into `unicode-range` subsets** by `src/frontend/scripts/subset-huninn.py` (needs `pip install fonttools brotli`; run from `src/frontend`): `src/fonts/huninn/ui.woff2` (~230KB: Latin, punctuation and every non-ASCII character found in `src/**/*.ts(x)` — i.e. all UI text) plus `cjk-NN` / `misc-NN` slices for the rest, and the generated `src/app/huninn.css` (`@font-face` rules, imported by `layout.tsx`; Next bundles the `url()`s as hashed, immutable assets). The browser downloads only the slices a page actually shows, so huninn appears almost immediately instead of after the old 2.2MB file. **Re-run the script after adding UI text with new CJK characters** (unlisted characters still render — they just come from a cjk slice). `ui` is declared last on purpose: with overlapping ranges the last face wins.
- 0xProto still loads via `next/font/local` in `layout.tsx` with `display: "swap"` **and `preload: false`** (next/font would otherwise preload it on every route and compete with the JS that gates interactivity). Never use `display: block` — it blanks text until the font arrives.
- **Huninn has a single weight (400). `body` sets `font-synthesis-weight: none`** because faux bold smears its rounded strokes until it looks like the system font (this was the "it isn't huninn" complaint). Build hierarchy from size and colour, not `font-semibold`/`font-bold` (they render as regular). `<strong>` is styled as a highlighter mark instead of bold. `.xterm` opts back into synthesis for bold terminal cells.
- `--font-mono` keeps `ui-monospace, 'Courier New', monospace` as fallback; `--font-sans` falls back to `ui-sans-serif, system-ui, sans-serif`. No Geist dependency.
- xterm.js reads the terminal font name from CSS variable `--font-0xproto` via `getComputedStyle(document.body)` and explicitly awaits `document.fonts.load()` for the mono font (1.5s timeout guard) before terminal initialization — it does not depend on the CJK font
- If a change to `globals.css`'s `@theme` seems ignored in `next dev`, delete `src/frontend/.next` — Turbopack can keep serving the previously compiled Tailwind theme.

## Favicon

- `src/frontend/src/app/icon.svg` is the source: brand-gradient tile (`--primary` → `--brand-2`, light theme, as hex) + a white "reverse tunnel" hairpin (dot → out → U-turn → arrow back). 64-unit grid, stroke 8, horizontal strokes on multiples of 4 so 16/32px stay pixel-sharp. Next.js file conventions emit the `<link>` tags.
- `favicon.ico` (16/32/48 PNG entries) and `apple-icon.png` (180×180, full-bleed — iOS masks the corners) are rendered from it with `sharp` (in the frontend's `node_modules`); re-render both whenever the SVG or the brand colours change. Never put a double hyphen inside the SVG comment (invalid XML → broken icon).
- The Swagger shell (`api/doc.rs`) links the same `/favicon.ico` + `/icon.svg`. In the UI the same glyph is `components/brand/TelepyGlyph.tsx` (strokes in currentColor, typed as a `LucideIcon`, drawn on a `bg-brand-gradient` tile): sidebar `BrandMark`, the login diagram, the wizard's Telepy node and the command sheet's tunnel chip. Use it wherever *Telepy itself* is shown; lucide `Cable` stays only as the generic "connect" icon.
- Brand assets for the README / GitHub live in `docs/brand/` (`logo.svg`, `logo-lockup.svg` + `-dark.svg`, `banner.svg` + `banner.png` 1280×640 = GitHub social preview, uploaded by hand in the repo settings), generated by `src/frontend/scripts/brand-assets.py` with the text outlined from jf-openhuninn; re-run it when the glyph, colours or tagline change.

## Internationalization (i18n) — REQUIRED for all frontend UI text

The frontend is fully internationalized (English / 繁體中文 / 日本語, default = browser language).
**Every user-visible string added, changed, or removed MUST go through the i18n system** — never
hardcode display text in components, hooks, or lib error builders.

### How it works

- **Dictionaries:** `src/frontend/src/locales/` — `en.ts` is the **source of truth** for keys
  (`export const en = {...} as const` → `TranslationKey = keyof typeof en`). `zh-TW.ts` and `ja.ts`
  are typed `Record<TranslationKey, string>`, so a missing or extra key is a **compile error**.
  Keys are flat `namespace.camelCase` (e.g. `tunnels.deleteMessage`), namespaced by feature
  (`common`, `nav`, `api`, `login`, `firstLogin`, `tunnels`, `tunnelActions`, `tunnelDetails`,
  `wizard`, `terminal`, `latency`, `kbd`, `files`, `browser`, `scripts`, `config`, `share`,
  `manageUsers`, `keys`, `logs`, `settings`, `security`, `siteSettings`, `prefs`, `language`, `network`, `join`, `ui`).
- **In components/hooks:** `const { t, tn, locale, language, setLanguage } = useI18n()` from
  `@/lib/i18n`. `t(key, vars?)` returns a string; `{var}` placeholders interpolate
  (`t("tunnels.deleted", { name })`). `tn(key, vars)` accepts ReactNode values so sentences keep
  inline `<code>`/`<strong>` without splitting the translation.
- **Outside React** (e.g. `lib/api.ts` error builders): use `translate()` from `@/lib/translate`
  (module-level; the provider keeps its locale in sync).
- **Preference resolution:** `"auto" | "en" | "zh-TW" | "ja"` stored in the `telepy.language`
  cookie, resolved **client-side**: a pre-paint inline script in `app/layout.tsx` sets
  `<html lang>`, and `I18nProvider` applies the locale in a `useLayoutEffect` before the hydrated
  frame paints. **Never read `cookies()`/`headers()` in the root layout** — that makes every
  route dynamic, disables full Link prefetch, and made page navigation take seconds (real
  regression, since reverted). After login the preference syncs with the backend `UserSettings`
  (`/api/user/settings`; also included in `/api/auth/user/profile` as `language`,
  `null` = never chosen → the frontend pushes its local preference up; see `UserSettingsSync`
  in `lib/i18n.tsx`).
- **Switcher locations:** sidebar footer — four inline buttons (Auto/EN/繁/日,
  `components/layout/LanguageSwitcher.tsx`; the sidebar is collapsible — state in localStorage
  `telepy.sidebarCollapsed`) — and the user-preferences modal (gear button in the sidebar
  footer, `components/layout/UserPreferencesModal.tsx`). Admins can also set a user's language
  via Settings → Users → Manage modal (`/api/user/users`, `/api/user/users/<id>`).
- **Other user preferences** (`lib/userPrefs.ts` + the `user_management_usersettings` row): `theme`
  (system/light/dark; class-based Tailwind dark mode, applied pre-paint by the same inline
  script from localStorage `telepy.theme`) and `terminal_font_size` (localStorage
  `telepy.terminalFontSize`; xterm reads it at init and live-applies via the
  `telepy:terminal-font-size` CustomEvent). Both sync server-side via `/api/user/settings`.
- **Site-setting labels/descriptions:** the settings page prefers dictionary keys
  `siteSettings.<field>.label` / `siteSettings.<field>.description` (localized), falling back
  to the backend `meta` (label/description embedded in `api/site_settings.rs`). **When adding a
  site setting, add the column in `db/schema.rs`, the field in `db/settings.rs` + `api/site_settings.rs`,
  and these two keys to all three dictionaries.**
- The Settings page (`/tunnels/settings`) is admin-only, tabbed by `?tab=`: Account & registration
  (default) / Remote browser (`remote_browser_*`) / AI access (`ai_*`, + MCP endpoint) / Users. Site
  settings land in a tab by key prefix, so a new key needs no page change; integer keys ending in
  `_timeout` / `_lifetime` are seconds and show a localized duration under the input. Personal
  preferences live in the sidebar gear modal (tabs: General / Security / Connected apps).

### Rules when changing UI

1. **Add/change a string:** add or edit the key in `en.ts` FIRST, then mirror it in `zh-TW.ts` and
   `ja.ts` (TypeScript fails the build until all three agree). Then use `t("the.key")` in code.
2. **Remove UI:** delete its keys from all three dictionaries (unused keys rot; the extra-key
   check only catches keys missing from zh-TW/ja, not orphans in en).
3. **Do NOT translate:** keycap glyphs (Esc/Tab/Ctrl/F1…), format examples in placeholders
   (`ssh-rsa AAAA…`, `22`), code/paths inside `<code>` (pass them as `tn()` vars), size units,
   product names (SSH, PowerShell, AutoSSH, Docker), the Telepy brand, and gateway log *messages*
   (rendered verbatim; the event badges next to them are translated via `logs.event.<kind>`).
4. Backend-provided text (server error `detail` fields, log lines) is NOT frontend-translated —
   it renders verbatim. Exceptions with a mapping layer: site-setting labels/descriptions use
   the `siteSettings.<field>.*` keys (fallback = backend meta), and remote-browser start
   errors with a machine-readable `code` (e.g. `device_offline`) map to `browser.*` keys, Google-login errors (`google_*`, `registration_closed`, `account_disabled`; `lib/loginErrors.ts`) map to `login.*` keys, and two-factor errors (`lib/mfa.ts`) map to `security.*` keys.
5. Locale-aware formatting: use `useI18n().locale` for `Date.toLocaleString()` /
   `Intl.DateTimeFormat` instead of hardcoding `'en-US'`.
6. `metadata` in `app/layout.tsx` deliberately stays English (localizing it would force dynamic
   rendering for every route).

## Code Conventions

- Backend: one module per former Django app under `api/`; handlers return `ApiResult<Json<Value>>` and build errors with `ApiError::{error,detail,field}` so the JSON shape matches what the frontend expects
- Business logic that is pure (permissions, debounce/throttle, template substitution, path resolution) lives in plain functions with unit tests; I/O stays in `api/`, `ws/`, `gateway/`
- Anything on an SSH path (gateway, device login, terminal, SFTP, laptop ProxyCommand/ProxyJump, sharing/username permissions) gets an end-to-end test on `tests/common/lab.rs`: `Lab::start()` runs the real gateway; `lab.machine(name, &[(os_user, &[keys])], allow_jump)` is a device/LAN sshd with per-OS-user `authorized_keys` and a login log (`logged_in(user, key)`); `lab.device(owner, name, &machine)` brings its tunnel up with a real `ssh -NR`; paths: `backend_exec` / `backend_sftp` (russh), `backend_ssh` (OpenSSH), `laptop_exec(user, &[Hop::Tunnel(..), Hop::Direct(..)], cmd)`, `generated_ssh_config`, `terminal` (WS). Users are created in the DB (no pbkdf2), so a scenario runs in seconds — see `tests/ssh_topology.rs`
- DB access goes through `db/*` functions (sqlx, runtime-checked queries against the Django-named tables); never alter or drop an existing column in `schema.rs`
- Frontend uses centralized `apiFetch()` with auto JWT injection and 401 handling
- **All frontend UI strings go through i18n (`useI18n().t` / `tn`) — see the i18n section above**
- Comments are mixed English and Traditional Chinese
- Frontend components follow Shadcn/Radix patterns with `class-variance-authority`
- **UI building blocks** (use these instead of hand-rolling): every dialog is `components/ui/Modal.tsx` (`title`, optional `description` / `icon` / `tone="danger"`, `footer` for the buttons; it focuses the panel on open instead of the close button, and becomes a bottom sheet on phones) and confirmations are `ConfirmDialog`; notices are `components/ui/callout.tsx` (`tone` info / tip / warning / danger — no more `bg-blue-50` / 💡 boxes); tabs and small single-choice toggles are `components/ui/segmented.tsx`; form fields are `Input` / `Textarea` / `Label`; every page starts with `components/layout/PageHeader.tsx` (gradient icon tile, title + addon, description, actions)
- Design tokens live in `globals.css`: surfaces `bg-card` (raised) / `bg-surface` (wells inside cards and dialogs) / `bg-muted` (tracks, chips), shadows `shadow-card` / `shadow-card-hover` / `shadow-pop` (menus, selects, tooltips, toasts) / `shadow-dialog`, overlay `bg-(--overlay)`; animations `animate-pop-in/out`, `animate-sheet-*`, `animate-toast-in` (there is no tw-animate plugin — `animate-in` / `slide-in-from-*` classes do nothing)
