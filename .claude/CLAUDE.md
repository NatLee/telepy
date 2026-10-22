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
      auth/           # jwt.rs, password.rs (Django pbkdf2_sha256), google.rs (JWKS), extractor.rs (Bearer → AuthUser, InternalService)
      api/            # REST handlers per former Django app: auth, tunnels, usernames, user_keys, reverse_keys, scripts, sharing, users, site_settings, logs, sftp, remote_browser, internal
      ws/             # WebSockets: auth.rs (first-message JWT), notifications, tunnel_connection, terminal (PTY), filemanager (SFTP), remote_browser (KasmVNC relay)
      gateway/        # in-process SSH server: pubkey auth from DB, tcpip-forward → 127.0.0.1:<port> loopback bridge, direct-tcpip, status + latency probes, sshd-style log
      monitor/        # StatusState (listening ports / latency), ports.rs (debounce + latency throttle), runner.rs (5 s cycle → notifications)
      hub.rs          # in-process notification hub (per-user / per-tunnel broadcast; replaced the Redis channel layer)
      ssh/            # process.rs (OpenSSH client argv + PTY spawn), device.rs (russh client to a device)
      sftp/           # path resolution, structured listing, zip download, upload
      remote_browser/ # ssh -D SOCKS session store, kasm session-manager client, reaper
      scripts/        # connection-script / ssh-config rendering ($var substitution, templates/)
      permissions.rs  # VIEW/EDIT/ADMIN hierarchy, allowed target usernames
    templates/        # ssh / autossh / systemd / PowerShell / docker scripts, ssh_config
    tests/            # integration tests (router in-process, real listener for WS, real OpenSSH client for the gateway)
    Dockerfile        # multi-stage build → debian-slim + openssh-client
  frontend/           # Next.js app (unchanged by the backend rewrite)
    src/app/          # Pages: login, first-login, tunnels (create/index/terminal/settings/logs/keys); root page.tsx redirects by auth state
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
- `INTERNAL_API_TOKEN` — secret for backend ↔ kasm-browser session-manager calls (and the internal endpoints)

## Architecture Notes

- **Services:** 4 containers via Docker Compose: Traefik, frontend, backend, kasm-browser. No Redis, no separate SSH container, no supervisor.
- **Routing:** Traefik routes `/api/*`, `/ws/*`, and a fixed set of `/tunnels/{share,unshare,shared-users,available-users,update-permission,server}` paths to the backend (`backend:8000`); everything else to the frontend. Traefik applies a `compress` middleware to HTTP routers (not `/ws`); the backend also compresses REST responses.
- **SSH gateway (`gateway/`):** the backend listens on 2222 (published as `REVERSE_SERVER_SSH_PORT`) with the host keys from `ssh/ssh_host_keys`. Only public-key auth (tunnel / user / service keys from the DB) and `tcpip-forward` are accepted; every forward binds `127.0.0.1:<reverse_port>` inside the backend container and bridges to a `forwarded-tcpip` channel, so the OpenSSH client (terminal, `ssh -D`) and russh (SFTP) reach the device in a single hop. `direct-tcpip` serves the generated ssh config's `ProxyCommand ssh -W` for user keys. Shell/exec/pty are refused.
- **Device-side scripts (`scripts/`, `templates/`):** rendered with Python `string.Template.safe_substitute` semantics (unknown `$names` survive, so shell variables in templates are fine). The Docker flavours use `jnovack/autossh` (env-driven, key mounted at `/id_rsa`, defaults to `~/.ssh/id_rsa`) and reach the device's sshd through `host.docker.internal` (`extra_hosts`/`--add-host host-gateway`, Docker 20.10+ / Docker Desktop); the compose one-liner needs `-f telepy-docker-compose.yml`. Scripts only ever *append* the service key to `authorized_keys`. There is no public `alpine/autossh` image — don't bring it back.
- **Status / latency:** forward registration and release update `StatusState` immediately; a banner round-trip through a forwarded channel every 15 s measures RTT. `monitor/runner.rs` runs the 5 s cycle (debounce FLAP_THRESHOLD 2, latency throttle 5 ms / 6-cycle keep-alive) and emits the `UPDATE-TUNNEL-*` notifications through the in-process hub.
- **WebSocket:** first frame `{type:"auth", token, …}` within 10 s; close codes 4000/4001 (auth), 4002/4003/4004/4005/4006 (terminal/file manager), 4403/4404/4011/4013 (remote browser). Terminal pong is a **binary** frame; the other sockets answer `{"type":"pong"}`.
- **Terminal:** `openpty` + OpenSSH client (`ControlMaster=auto`, `ControlPersist=600`, `ControlPath=/tmp/ssh_term_%r@%h:%p`); on disconnect only the direct child gets SIGTERM → SIGKILL (never killpg — the mux master would die and kick every other tab).
- **Permissions:** hierarchical tunnel access — VIEW / EDIT / ADMIN — in `permissions.rs` (+ allowed target usernames per share).
- **TLS / deployment:** prod sits behind an upstream TLS-terminating proxy that forwards `http` to Traefik `:80`; Traefik keeps the upstream `X-Forwarded-*` headers (`forwardedHeaders.insecure: true`), and the backend uses `X-Forwarded-Proto` / `X-Forwarded-Host` for the one-time script URL. If Traefik `:80` is reachable from untrusted networks, switch `insecure: true` → `trustedIPs`.
- **Startup / health:** the backend reconciles the schema, seeds the `web-service` key from `/root/.ssh/id_rsa.pub`, stops orphaned remote-browser sessions, starts the gateway and the monitor, then listens. `GET /api/auth/setup-status` is the public health endpoint used by the compose `healthcheck` and Traefik's `healthCheck`.
- **API docs (`api/doc.rs`, `api/schemas.rs`):** every REST handler carries a `#[utoipa::path]` attribute and each `api/*::router()` is a `utoipa_axum::OpenApiRouter` (`routes!`), so the OpenAPI document is generated from the real routes; `app::openapi()` returns it without state. Swagger UI is at `/api/__hidden_swagger`, the spec at `/api/openapi.json`; **both need a login** — the spec takes a Bearer token (`AuthUser`), the page is a same-origin shell whose initializer verifies/refreshes the frontend's localStorage token and redirects to `/login` otherwise (`OPENAPI_ENABLED=false` removes them). Handlers still return `serde_json::Value`, so the `schemas.rs` structs are documentation only — **when you change a response/request shape, update the matching struct** (and `tests/openapi.rs` asserts the key paths/security). A PUT+PATCH pair needs two handler fns (`update` + `replace`), one per `#[utoipa::path]`.
- **Tunnels list data:** `GET /api/reverse/server/dashboard` returns `{tunnels, ports, latency}` in one round-trip; the list serializer uses a precomputed permission map + share counts (no per-row queries).
- **Logging:** `tracing` → stdout + daily rolling `/logs/telepy.log` and `/logs/error.log` (a bare `LOG_LEVEL=debug` silences sqlx/hyper/russh internals; pass a full EnvFilter directive to override). Gateway events (accepted / forward / disconnect / refused …) go to the `telepy_gateway_event` table (capped at 100k rows) and are also appended sshd-style to `/logs/ssh-gateway.log`; `/api/log/ssh/events?limit=&tunnel_id=` returns them as JSON (what the Logs page uses; oldest first) and `/api/log/ssh` renders the last 500 as sshd-style text (200 with an empty string when there are none). **Both are scoped:** admins (`is_superuser`) see every event, other users only events of tunnels they own or that are shared with them (tunnel-less events such as `listening` are admin-only; a foreign `tunnel_id` is a 404). The Logs page (`/tunnels/logs?tunnel=<id>`) keeps the tunnel filter in the URL and the tunnel actions menu deep-links to it; event badges key off the structured `event` field (`logs.event.*` i18n keys), not message text.
- **Compatibility rules:** JSON shapes, status codes and error strings mirror the former DRF views (the frontend parses `{detail}` / `{error}` / `{field: [...]}`); keep them unless the frontend is changed in the same PR. DB datetimes are stored as naive UTC with microseconds (Django format) and serialised as `+08:00` ISO (DRF field) or `…Z` (DRF encoder) exactly where the old code did.
- **Rollback:** `git checkout a622634` (last commit with the Python stack) restores the Django compose; the SQLite file and `SECRET_KEY` are shared, so switching either way keeps users logged in.

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
- DB access goes through `db/*` functions (sqlx, runtime-checked queries against the Django-named tables); never alter or drop an existing column in `schema.rs`
- Frontend uses centralized `apiFetch()` with auto JWT injection and 401 handling
- **All frontend UI strings go through i18n (`useI18n().t` / `tn`) — see the i18n section above**
- Comments are mixed English and Traditional Chinese
- Frontend components follow Shadcn/Radix patterns with `class-variance-authority`
