# CLAUDE.md — Telepy

## Project Overview

Telepy is a full-stack web application for managing reverse SSH tunnels. It provides a web UI for creating/managing tunnels, a WebSocket-based terminal console, SFTP file management, remote browser sessions (KasmVNC, see `docs/remote-browser.md`), RDP / VNC remote desktops in the browser (guacd, see `docs/remote-desktop.md`), and tunnel sharing with permission controls.

The backend is a single Rust process (`src/backend-api/`, binary `telepy-server`) that serves the REST API and WebSockets **and terminates the devices' reverse SSH tunnels itself** (in-process SSH gateway). The migration from the previous Django backend is documented in `docs/engineering/rust-migration-plan.md`; the API/WebSocket contract is byte-compatible with it, so the frontend did not change.

## Tech Stack

- **Backend:** Rust (edition 2021) / axum 0.8 + tokio / sqlx (SQLite) / russh (SSH server for the gateway, SSH+SFTP client to devices) / jsonwebtoken / tower-http
- **Frontend:** Next.js 16 (App Router) / TypeScript / Tailwind CSS 4 / Radix UI / xterm.js
- **Database:** SQLite3 (`/data/db.sqlite3`, Django-era table names kept)
- **Auth:** Google OAuth2 (id_token verified against Google JWKS) + OIDC single sign-on (any OpenID Connect provider, see **Single sign-on** in `.claude/rules/auth.md`) + JWT (simplejwt-compatible HS256; `SECRET_KEY` env, legacy default with a startup warning); sign-in lifetimes are site settings, see **Web sign-in sessions** in `.claude/rules/auth.md`
- **Infra:** Docker Compose / Traefik v3 (reverse proxy)
- **Browser:** KasmVNC + Chromium in the `kasm-browser` container (per-session Xkasmvnc, WS↔WS relay through the backend; the frontend uses the vendored KasmVNC noVNC fork in `src/frontend/src/vendor/kasm-novnc/`)

## Project Structure

```
src/
  backend-api/        # Rust backend (crate telepy-server)
    src/
      …               # one directory per area; the module-by-module map is in .claude/rules/backend.md
    Dockerfile        # multi-stage build → debian-slim + openssh-client
  cli/                # `telepy` command line (crate telepy-cli, its own Cargo.lock; the server build never sees it; release builds via .github/workflows/release-cli.yml on every published GitHub release: five targets, version = the tag (`TELEPY_VERSION`), version-less asset names so `releases/latest/download/telepy-<target>.tar.gz` is stable)
  carrier/            # `telepy-carrier` (crate telepy-carrier, lib + bin): the device-side web-port helper — a static Rust binary that is the device's ssh ProxyCommand (SSH port first with the banner check, else SSH inside a WebSocket to /ws/gateway/; HTTP CONNECT proxy via HTTPS_PROXY / --proxy / NO_PROXY; roots = system + webpki; ring only), and with the default `client` feature also the **built-in SSH client** (`telepy-carrier tunnel` / `keygen`, `src/tunnel.rs`; russh 0.64 with ring only) for devices without a usable ssh. The CLI's `_carrier` uses the same lib with `default-features = false` (no russh in the CLI). Built by release-cli.yml for the five CLI targets plus armv7 / armv6 musl (carrier only, `cross`); `telepy-carrier-<target>.tar.gz|.zip` on every release. Tests: unit + `tests/e2e.rs` (the built binary as a ProxyCommand on the SSH lab, incl. a fake CONNECT proxy, and `tunnel` over the SSH port / web port / wrong host key / probe / SIGTERM)
  frontend/           # Next.js app (unchanged by the backend rewrite)
    src/app/          # Pages: login, first-login, tunnels (create/index/terminal/settings/logs/keys/cheatsheet/network/mcp/activity); root page.tsx redirects by auth state
    src/components/   # UI components (Shadcn-style + Radix)
    src/fonts/        # Local font files: huninn unicode-range subsets (src/app/huninn.css) + 0xProto (next/font/local) + terminal/ (Nerd Font Mono choices, src/app/terminal-fonts.css)
    src/hooks/        # Custom React hooks (WebSocket, notifications, etc.)
    src/lib/          # API client, auth, WebSocket, i18n, utilities
    src/locales/      # i18n dictionaries: en.ts (key source of truth), zh-TW.ts, ja.ts
    src/types/        # TypeScript type definitions
  configs/traefik/    # Traefik static + dynamic config
docker/kasm-browser/  # KasmVNC + Chromium image and its session-manager
ssh/                  # backend_ssh_key (service key + ssh config), ssh_host_keys (gateway host keys; generated, git-ignored)
docs/                 # user docs in three languages: <name>.md (English) + <name>.zh-TW.md + <name>.ja.md, same headings in the same order — change all three
                      # together (README.md = the index, visual-guide.md, device-join, remote-desktop, remote-browser, proxy, cli, mcp, webhooks, sso, device-connections,
                      # latency-deep-dive, benchmarks); images/<lang>/ = the app's info-dialog diagrams + GIFs those docs embed (same file names per language);
                      # engineering/ = notes kept in Traditional Chinese only (rust-migration-plan.md, rustdesk-spike.md, rustdesk-id-server.md, articles/) — not user docs, one language;
                      # screenshots/<lang>/ (the README images, one set per language; retake all three when a shown screen changes — how in screenshots/README.md)
```

## Development Commands

### Docker (primary workflow)

```bash
docker compose up -d --build            # Start all services
docker compose up -d --build backend    # Rebuild the Rust backend only
docker compose up -d --build frontend
```

### Maintenance = `telepy-server` inside the container (no host-side wrapper scripts; the same on every OS)

```bash
docker compose exec backend telepy-server doctor            # Read-only health check: config, keys, DB, guacd, kasm, GeoIP, audit chain (exit 1 on ✗); the admin Server health page runs the same
docker compose exec backend telepy-server create-superuser --username admin --password 1234   # (the first account is a superuser anyway)
docker compose exec backend telepy-server keygen            # Create missing gateway host keys (GATEWAY_HOST_KEYS_DIR) + the service key (SSH_IDENTITY); `serve` does the same at every start; existing keys are kept
docker compose exec backend telepy-server geoip             # Download DB-IP Lite (country + ASN) into GEOIP_DIR (`datasets.rs`; same as Server health's "IP and vendor data" panel); the backend picks the files up within an hour and keeps them current after that
docker compose exec backend telepy-server oui               # Download IEEE's OUI registry into OUI_DIR/oui.csv so LAN hosts show their NIC vendor; picked up and kept current the same way
docker compose exec backend telepy-server migrate           # Reconcile the DB schema (runs automatically on start)
docker compose logs -f backend                               # Follow the backend's logs
```

### Backend (local, needs rustup)

```bash
cd src/backend-api
cargo test                    # unit + integration tests (needs ssh/ssh-keygen and, for the SFTP test, a local sftp-server; both skip otherwise)
cargo run -- serve            # DATA_DIR / LOG_ROOT default to ./data ./logs; gateway only when GATEWAY_HOST_KEYS_DIR points at host keys
cargo run -- create-superuser --username admin --password 1234
cargo run -- openapi > openapi.json   # dump the OpenAPI document (no DB / server / login needed)
cargo run -- doctor           # read-only checks: config, DB, service key, gateway host keys, guacd, kasm, GeoIP, audit chain (`--json`; exit 1 on a failure)
cargo run -- import-user-keys keys.json [--dry-run]   # add personal SSH public keys to existing accounts: [{"username", "name", "key", "expires_at"?, "description"?}]; same checks as POST /api/reverse/user/keys; exit 1 when any entry was skipped
cargo run -- fetch-carriers   # prefetch every platform's telepy-carrier from TELEPY_RELEASES_URL into CARRIER_DIR (else each is fetched on a device's first request)
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
- `SSH_SERVER_DOMAIN` — optional separate name for SSH (devices' tunnels, laptops' `HostName`, the join's `GATEWAY_HOST`); empty = `SERVER_DOMAIN`. For a web name behind a proxy that only carries web ports (Cloudflare's orange cloud, another CDN, an HTTP load balancer)
- `INTERNAL_API_TOKEN` — secret for backend → kasm-browser session-manager calls
- More variables (`TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`, `CARRIER_DIR` / `TELEPY_RELEASES_URL` / `TELEPY_RELEASE_KEYS`, `GEOIP_DIR` / `OUI_DIR`, `GATEWAY_PROXY_PROTOCOL_FROM`) and which ones are optional overrides of Site settings → Server: `.claude/rules/deploy.md`

## Architecture Notes

- **Services:** 5 containers via Docker Compose: Traefik, frontend, backend, kasm-browser, guacd (remote desktop engine, only on the internal `telepy-desktop` network with the backend). No Redis, no separate SSH container, no supervisor.
- **Routing:** Traefik routes `/api/*`, `/ws/*`, and a fixed set of `/tunnels/{share,unshare,shared-users,available-users,update-permission,server}` paths to the backend (`backend:8000`); everything else to the frontend. Traefik applies a `compress` middleware to HTTP routers (not `/ws`); the backend also compresses REST responses.
- **Compatibility rules:** JSON shapes, status codes and error strings mirror the former DRF views (the frontend parses `{detail}` / `{error}` / `{field: [...]}`); keep them unless the frontend is changed in the same PR. DB datetimes are stored as naive UTC with microseconds (Django format) and serialised as `+08:00` ISO (DRF field) or `…Z` (DRF encoder) exactly where the old code did.
- Every feature's notes (design, invariants, tests to run) live in `.claude/rules/` — see **Where the detailed notes live** at the end.

## Internationalization (i18n) — REQUIRED for all frontend UI text

The frontend is fully internationalized (English / 繁體中文 / 日本語, default = browser language).
**Every user-visible string added, changed, or removed MUST go through the i18n system** — never
hardcode display text in components, hooks, or lib error builders.

### Rules when changing UI

1. **Add/change a string:** add or edit the key in `en.ts` FIRST, then mirror it in `zh-TW.ts` and
   `ja.ts` (TypeScript fails the build until all three agree). Then use `t("the.key")` in code.
2. **Wording:** in zh-TW a tunnel is always **通道** (never 隧道 — `src/locales/terms.test.ts` fails on it); 通道 also stays for a sound channel.
3. **Remove UI:** delete its keys from all three dictionaries (unused keys rot; the extra-key
   check only catches keys missing from zh-TW/ja, not orphans in en).
4. **Do NOT translate:** keycap glyphs (Esc/Tab/Ctrl/F1…), format examples in placeholders
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

- **License:** AGPL-3.0-only (`LICENSE`), with a commercial license on the side and the pre-October-2026 MIT notice kept in `NOTICE`. New dependencies or vendored code must be AGPL-compatible (MIT / BSD / Apache-2.0 / MPL-2.0 / LGPL are fine; GPL-2.0-only, SSPL, proprietary are not); vendored code keeps its license text next to it (`src/frontend/.gitignore` ignores `*.txt` except `src/vendor/**/LICENSE.txt`). External contributions need the CLA in `CONTRIBUTING.md` (box in `.github/pull_request_template.md`)
- Backend: one module per former Django app under `api/`; handlers return `ApiResult<Json<Value>>` and build errors with `ApiError::{error,detail,field}` so the JSON shape matches what the frontend expects
- Business logic that is pure (permissions, debounce/throttle, template substitution, path resolution) lives in plain functions with unit tests; I/O stays in `api/`, `ws/`, `gateway/`
- Anything on an SSH path (gateway, device login, terminal, SFTP, laptop ProxyCommand/ProxyJump, sharing/username permissions) gets an end-to-end test on `tests/common/lab.rs`: `Lab::start()` runs the real gateway; `lab.machine(name, &[(os_user, &[keys])], allow_jump)` is a device/LAN sshd with per-OS-user `authorized_keys` and a login log (`logged_in(user, key)`); `lab.device(owner, name, &machine)` brings its tunnel up with a real `ssh -NR`; paths: `backend_exec` / `backend_sftp` (russh), `backend_ssh` (OpenSSH), `laptop_exec(user, &[Hop::Tunnel(..), Hop::Direct(..)], cmd)`, `generated_ssh_config`, `terminal` (WS). Users are created in the DB (no pbkdf2), so a scenario runs in seconds — see `tests/ssh_topology.rs`
- DB access goes through `db/*` functions (sqlx, runtime-checked queries against the Django-named tables); never alter or drop an existing column in `schema.rs`
- Frontend uses centralized `apiFetch()` with auto JWT injection and 401 handling
- **All frontend UI strings go through i18n (`useI18n().t` / `tn`) — see the i18n section above**
- Comments are mixed English and Traditional Chinese
- Frontend components follow Shadcn/Radix patterns with `class-variance-authority`

## Where the detailed notes live

This file is loaded in full by every session, so it holds only what every task needs. The per-feature notes are in `.claude/rules/<area>.md`; each starts with a `paths:` list and is loaded only when a file matching one of those globs is read or edited. Before working on an area whose files you have not opened yet, read its file directly.

| File | Covers |
|---|---|
| `backend.md` | Startup, API docs, WebSocket protocol, status / latency, logging |
| `gateway.md` | Gateway, tunnel names, connection history, key expiry, tunnel health, per-tunnel service keys, host-key pinning |
| `device-join.md` | Device-side scripts, device join, device platforms + way in, web-port carriers, release signing, automatic transport |
| `device-install.md` | Device key lists, deleting a tunnel, long requests, switching the way in, install names |
| `lan.md` | LAN discovery, jump hosts, the Network page |
| `cli.md` | Personal API tokens + the telepy CLI, CLI page |
| `ssh-config.md` | Create wizard, SSH config dialog, SSH config editor + simplifier, command sheet |
| `notifications.md` | Webhooks, notification preferences, installable app (PWA), push notifications |
| `terminal.md` | Terminal page + path pickers, terminal, shell history, terminal appearance, toolbox |
| `files.md` | File manager |
| `sessions.md` | Console session events, presence, live sessions, access loss, terminal watching, terminal recording, command rules |
| `access.md` | Target accounts dialog, permissions, tunnel identity, feature permissions / roles, people lists, timed sharing, access requests, step-up, mine vs admin |
| `groups.md` | Sharing with groups (admin-kept and personal), pins and labels, tunnel groups + key groups |
| `auth.md` | Two-factor sign-in, single sign-on (OIDC), web sign-in sessions, your devices |
| `signin-look.md` | Sign-in page look |
| `client-ip.md` | Client IP + sign-in history, IP retention |
| `device-info.md` | GeoIP + IP-change alerts, device addresses, device facts, device public IP |
| `mcp.md` | OAuth 2.1 (MCP connectors), MCP server + AI sessions, interactive shells + agent browsers over MCP |
| `remote-desktop.md` | Remote desktop, RustDesk in the browser |
| `remote-browser.md` | Remote browser panel, the device's own ports |
| `proxy.md` | Device proxy (`proxy:use`): the core, `/ws/proxy/`, `telepy proxy`, the API page's Proxy tab |
| `tunnels-ui.md` | Tunnels list data, dense rows, tunnel page + quick-access menu, list search |
| `frontend.md` | How i18n works, user preferences, type scale, Site settings page layout, UI building blocks, design language, design tokens |
| `brand.md` | Fonts, favicon, easter eggs + Tapi, disclaimer, sponsoring |
| `deploy.md` | More environment variables + the override model, TLS / deployment, SSH host vs web host, env-backed site settings |

- Notes refer to each other by their bold title (`**Terminal appearance**`, "the CLI bullet"): `grep -rn '\*\*<title>' .claude/rules/` finds the file.
- **New or changed notes go into the matching rules file, not here.** A new area gets a new file with its own `paths:` (keep the globs narrow: `src/backend-api/**` or `src/frontend/**` on a feature file would load it for almost every task) and a row in the table above. When a feature adds files, add them to that file's `paths:`.
- Keep this file under 25 KB and each rules file under about 40 KB; split a file that outgrows it.
