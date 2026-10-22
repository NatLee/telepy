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
      ssh/            # process.rs (OpenSSH client argv + PTY spawn), device.rs (russh client to a device)
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
    src/app/          # Pages: login, first-login, tunnels (create/index/terminal/settings/logs/keys/cheatsheet); root page.tsx redirects by auth state
    src/components/   # UI components (Shadcn-style + Radix)
    src/fonts/        # Local font files (loaded via next/font/local)
    src/hooks/        # Custom React hooks (WebSocket, notifications, etc.)
    src/lib/          # API client, auth, WebSocket, i18n, utilities
    src/locales/      # i18n dictionaries: en.ts (key source of truth), zh-TW.ts, ja.ts
    src/types/        # TypeScript type definitions
  configs/traefik/    # Traefik static + dynamic config
docker/kasm-browser/  # KasmVNC + Chromium image and its session-manager
ssh/                  # backend_ssh_key (service key + ssh config), ssh_host_keys (gateway host keys; generated, git-ignored)
dev-scripts/          # Helper scripts behind telepy.sh / telepy.ps1
docs/                 # remote-browser.md, latency-deep-dive.md, rust-migration-plan.md, articles/
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
- **SSH gateway (`gateway/`):** the backend listens on 2222 (published as `REVERSE_SERVER_SSH_PORT`) with the host keys from `ssh/ssh_host_keys`. Only public-key auth (tunnel / user keys from the DB) and `tcpip-forward` are accepted — the service key is deliberately **not** accepted (the backend reaches devices over loopback; that key sits in every device's `authorized_keys`), a tunnel key may only forward its own port and a user key only ports of tunnels the user owns; every forward binds `127.0.0.1:<reverse_port>` inside the backend container and bridges to a `forwarded-tcpip` channel, so the OpenSSH client (terminal, `ssh -D`) and russh (SFTP) reach the device in a single hop. `direct-tcpip` serves the generated ssh config's `ProxyCommand ssh -W` for user keys. Shell/exec/pty are refused. Device-side scripts are unchanged.
- **Device-side scripts (`scripts/`, `templates/`):** rendered with Python `string.Template.safe_substitute` semantics (unknown `$names` survive, so shell variables in templates are fine). The Docker flavours use `jnovack/autossh` (env-driven, key mounted at `/id_rsa`, defaults to `~/.ssh/id_rsa`) and reach the device's sshd through `host.docker.internal` (`extra_hosts`/`--add-host host-gateway`, Docker 20.10+ / Docker Desktop); the compose one-liner needs `-f telepy-docker-compose.yml`. Scripts only ever *append* the service key to `authorized_keys`. There is no public `alpine/autossh` image — don't bring it back.
- **Status / latency:** forward registration and release update `StatusState` immediately; a banner round-trip through a forwarded channel every 15 s measures RTT. `monitor/runner.rs` runs the 5 s cycle (debounce FLAP_THRESHOLD 2, latency throttle 5 ms / 6-cycle keep-alive) and emits the `UPDATE-TUNNEL-*` notifications through the in-process hub.
- **WebSocket:** first frame `{type:"auth", token, …}` within 10 s; close codes 4000/4001 (auth), 4002/4003/4004/4005/4006 (terminal/file manager), 4403/4404/4011/4013 (remote browser). Terminal pong is a **binary** frame; the other sockets answer `{"type":"pong"}`.
- **Terminal:** `openpty` + OpenSSH client (`ControlMaster=auto`, `ControlPersist=600`, `ControlPath=/tmp/ssh_term_%r@%h:%p`); on disconnect only the direct child gets SIGTERM → SIGKILL (never killpg — the mux master would die and kick every other tab).
- **Permissions:** hierarchical tunnel access — VIEW / EDIT / ADMIN — in `permissions.rs` (+ allowed target usernames per share).
- **TLS / deployment:** prod sits behind an upstream TLS-terminating proxy that forwards `http` to Traefik `:80`; Traefik keeps the upstream `X-Forwarded-*` headers (`forwardedHeaders.insecure: true`), and the backend uses `X-Forwarded-Proto` / `X-Forwarded-Host` for the one-time script URL. If Traefik `:80` is reachable from untrusted networks, switch `insecure: true` → `trustedIPs`.
- **Startup / health:** the backend reconciles the schema, seeds the `web-service` key from `/root/.ssh/id_rsa.pub`, stops orphaned remote-browser sessions, starts the gateway and the monitor, then listens. `GET /api/auth/setup-status` is the public health endpoint used by the compose `healthcheck` and Traefik's `healthCheck`.
- **API docs (`api/doc.rs`, `api/schemas.rs`):** every REST handler carries a `#[utoipa::path]` attribute and each `api/*::router()` is a `utoipa_axum::OpenApiRouter` (`routes!`), so the OpenAPI document is generated from the real routes; `app::openapi()` returns it without state. Swagger UI is at `/api/__hidden_swagger`, the spec at `/api/openapi.json`; **both need a login** — the spec takes a Bearer token (`AuthUser`), the page is a same-origin shell whose initializer verifies/refreshes the frontend's localStorage token and redirects to `/login` otherwise (`OPENAPI_ENABLED=false` removes them). Handlers still return `serde_json::Value`, so the `schemas.rs` structs are documentation only — **when you change a response/request shape, update the matching struct** (and `tests/openapi.rs` asserts the key paths/security). A PUT+PATCH pair needs two handler fns (`update` + `replace`), one per `#[utoipa::path]`.
- **OAuth 2.1 (MCP connectors, `oauth/` + `api/oauth.rs` + `db/oauth.rs` + `auth/mcp.rs`):** Telepy is its own authorization server. Discovery at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource[/mcp]` (Traefik routes `/.well-known/oauth-*` to the backend); `POST /api/oauth/register` (RFC 7591, public); the authorization endpoint is the **frontend** page `/oauth/authorize`, which calls `GET/POST /api/oauth/authorize` with the web JWT (the web login lives in localStorage, so the backend cannot see it on a redirect); the page (`app/oauth/authorize/page.tsx` + `hooks/useOAuthConsent.ts`) forwards the client's query verbatim, sends a logged-out user to `/login?next=<this url>` (`safeNextPath()` in `useLoginPage.ts` only accepts same-origin paths), shows the client name **and** `redirect_host` (registration is open, names are attacker-controlled), lets the user drop scopes / restrict tunnels, and `window.location.assign`s the returned `redirect_to`; errors without `redirect_to` are shown without redirecting. `next.config.ts` sends `X-Frame-Options: DENY` + `frame-ancestors 'none'` for `/oauth/*`. Connected apps (revoke) live in the preferences modal (`components/layout/ConnectedApps.tsx`); the Settings page groups `ai_*` site settings under "AI access"; `POST /api/oauth/token` (authorization_code + PKCE S256 only, refresh_token rotated on every use, compare-and-swap), `POST /api/oauth/revoke`, `GET/DELETE /api/oauth/grants` (Connected apps). Authorization codes live in memory (`tokens.rs`, 10 min, single use); grants in `telepy_oauth_grant` (refresh token SHA-256 only, optional tunnel restriction, scopes `tunnels:read` / `ssh:exec` / `ssh:files`). Access tokens are 1 h JWTs with `token_type: "mcp_access"` — not accepted by the REST extractor, and web tokens are not accepted by `auth::mcp::resolve`, which also re-checks the grant and the user on every request (revocation is immediate). Issuer = `PUBLIC_URL`, else derived from X-Forwarded-Proto/Host.
- **MCP server + AI sessions (`mcp/`, `ai/`, `api/ai.rs`, `db/ai_audit.rs`; user doc `docs/mcp.md`):** `POST /mcp` is rmcp's Streamable HTTP service in stateless mode (`legacy_session_mode = false`, JSON responses, `NeverSessionManager`, host check disabled because every request needs a bearer) behind `require_token`, which calls `auth::mcp::resolve` and answers 401 + `WWW-Authenticate: Bearer resource_metadata=…` (Traefik router `backend-mcp`, no compression; rmcp rejects requests without a `Host` header). The `McpPrincipal` reaches tools through `Extension<http::request::Parts>`. Tools: `list_tunnels`, `tunnel_status`, `ssh_session_open/exec/list/close`, `sftp_list/read/write`; scope checks return a tool error (`isError`) that tells the agent what to ask for. An AI session is one russh `DeviceConn` reused by every command (exec channel per command, ≤ 4 at once, no PTY), owned by (user, grant) — MCP 2026-07-28 has no transport sessions — and closed by the agent, the web (`DELETE /api/ai/sessions/{id}`: user, tunnel owner, admin), idle / max-lifetime (site settings `ai_session_idle_timeout` 600, `ai_session_max_lifetime` 7200, `ai_max_sessions_per_user` 3), device offline, grant revocation (immediately, from `revoke_grant_by_id`) or lost permission/username (reaper every 30 s, `ai::reap_once`). Opening/closing notifies the user and the tunnel owner (`AI-SESSION-OPENED` / `AI-SESSION-CLOSED`); every tool call is a `telepy_ai_audit_event` row (100k cap) served by `GET /api/ai/activity` (admins all; others own + own tunnels). Tests: `tests/mcp_api.rs` runs a fake device sshd (russh server: `sh -c` exec + local `sftp-server`).
- **Command sheet (`/tunnels/cheatsheet?tunnel=<id>`):** copy-ready `ssh -L/-R/-D/-J`, `scp`/`rsync` commands per tunnel, built by the pure `lib/forwardRecipes.ts` (each command = segments with an i18n explanation key, which drive the coloured display, tooltips and legend) plus an animated flow diagram. Every forward rides an SSH session to the device itself (the gateway only allows `direct-tcpip` to `localhost:<reverse_port>`). Aliases come from `GET /tunnels/server/config/{id}`, which besides `config`/`usernames` returns `server {alias, host, port}`, `hosts [{alias, username, username_id}]` and `reverse_port` — keep them in sync with the rendered stanzas.
- **Two-factor sign-in (`mfa/`, `mfa/passkey.rs`, `api/mfa.rs`, `db/mfa.rs`; tests `tests/mfa_api.rs`):** an account has 2FA when it has an enabled TOTP or at least one passkey. `/api/auth/token` and `/api/auth/google/token` then answer `{mfa_required, mfa_token, methods}` instead of tokens (`api::mfa::complete_login`); `POST /api/auth/mfa/verify` finishes with `totp` / `recovery_code` / `passkey` (options from `/api/auth/mfa/passkey/options`). Passwordless: `POST /api/auth/passkey/options` (discoverable, `mediation: conditional`) → `POST /api/auth/passkey/login`. Management under `/api/auth/mfa*` and `/api/auth/passkeys*`; adding/removing a factor and regenerating recovery codes need a `reauth` proof once the account has any factor (`require_reauth`, 403 `code: reauth_required`), and so does approving an MCP app on the OAuth consent page. Admin reset: `DELETE /api/user/users/{id}/mfa`. TOTP = RFC 6238 SHA-1/6/30 s, ±1 step, last step stored (no replay, compare-and-set); the secret is AES-256-GCM-sealed with a key derived from `SECRET_KEY` (rotating it breaks existing TOTP — users fall back to passkeys / recovery codes / admin reset). Recovery codes: 10, SHA-256 only, issued with the first factor and cleared with the last. Lockout: 10 failures per user per 15 min (a success resets it), 5 tries per `mfa_token`, challenges and WebAuthn ceremonies live in memory for 5 min and are single use. Passkeys use `webauthn-rs` 0.5 (links OpenSSL; `libssl-dev` / `libssl3` in the Dockerfile), RP ID = host of `PUBLIC_URL` / forwarded headers (`localhost` allows any port; IP addresses are rejected because browsers refuse them); credentials are stored as the serialised `Passkey` with the counter updated on use. Error bodies are `{error, code}`.
- **Tunnels list data:** `GET /api/reverse/server/dashboard` returns `{tunnels, ports, latency}` in one round-trip; the list serializer uses a precomputed permission map + share counts (no per-row queries).
- **Logging:** `tracing` → stdout + daily rolling `/logs/telepy.log` and `/logs/error.log` (a bare `LOG_LEVEL=debug` silences sqlx/hyper/russh internals; pass a full EnvFilter directive to override). Gateway events (accepted / forward / disconnect / refused …) go to the `telepy_gateway_event` table (capped at 100k rows) and are also appended sshd-style to `/logs/ssh-gateway.log`; `/api/log/ssh/events?limit=&tunnel_id=` returns them as JSON (what the Logs page uses; oldest first) and `/api/log/ssh` renders the last 500 as sshd-style text (200 with an empty string when there are none). **Both are scoped:** admins (`is_superuser`) see every event, other users only events of tunnels they own or that are shared with them (tunnel-less events such as `listening` are admin-only; a foreign `tunnel_id` is a 404). The Logs page (`/tunnels/logs?tunnel=<id>`) keeps the tunnel filter in the URL and the tunnel actions menu deep-links to it; event badges key off the structured `event` field (`logs.event.*` i18n keys), not message text.
- **Compatibility rules:** JSON shapes, status codes and error strings mirror the former DRF views (the frontend parses `{detail}` / `{error}` / `{field: [...]}`); keep them unless the frontend is changed in the same PR. DB datetimes are stored as naive UTC with microseconds (Django format) and serialised as `+08:00` ISO (DRF field) or `…Z` (DRF encoder) exactly where the old code did.

## Fonts

- **Chinese (CJK):** jf-openhuninn (`src/frontend/src/fonts/jf-openhuninn-2.1.woff2`, converted from the TTF) — used as primary `font-sans`
- **Terminal / Monospace:** 0xProto Nerd Font (`src/frontend/src/fonts/0xProtoNerdFont-Regular.woff2`) — used as primary `font-mono` and xterm.js terminal font
- Source TTF files kept alongside the woff2 in `src/frontend/src/fonts/`; regenerate woff2 with `fonttools` (`font.flavor = "woff2"`)
- Loaded via `next/font/local` in `layout.tsx` with `display: "swap"` **and `preload: false`** (text renders immediately with a system fallback, then swaps — do NOT switch back to `block`, it blanks all text until the 2.2MB CJK font finishes downloading). `preload: false` is deliberate: `next/font` otherwise injects a high-priority `<link rel="preload">` for BOTH fonts (~3.1MB, incl. the 2.18MB CJK) on **every** route, stealing bandwidth from the JS that gates interactivity; `swap` already paints text instantly, so preloading buys nothing above-the-fold. Fonts now load lazily off the critical path.
- Tailwind CSS variables `--font-sans` / `--font-mono` reference the custom fonts first, then generic system fonts as fallback (`ui-sans-serif, system-ui, sans-serif` for sans; `ui-monospace, 'Courier New', monospace` for mono — see `globals.css`). No Geist dependency.
- xterm.js reads the terminal font name from CSS variable `--font-0xproto` via `getComputedStyle(document.body)` and explicitly awaits `document.fonts.load()` for the mono font (1.5s timeout guard) before terminal initialization — it does not depend on the CJK font

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
  `manageUsers`, `keys`, `logs`, `settings`, `siteSettings`, `prefs`, `language`, `ui`).
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
- The Settings page (`/tunnels/settings`) is admin-only (Site Settings + Users tabs); personal
  preferences live in the sidebar gear modal.

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
   errors with a machine-readable `code` (e.g. `device_offline`) map to `browser.*` keys.
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
