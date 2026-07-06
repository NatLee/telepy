# CLAUDE.md — Telepy

## Project Overview

Telepy is a full-stack web application for managing reverse SSH tunnels. It provides a web UI for creating/managing tunnels, a WebSocket-based terminal console, SFTP file management, remote browser sessions (KasmVNC, see `docs/remote-browser.md`), and tunnel sharing with permission controls.

## Tech Stack

- **Backend:** Python 3.12 / Django 6.0 / Django REST Framework / gunicorn+uvicorn (prod ASGI; dev uses runserver via daphne) / Channels (WebSocket)
- **Frontend:** Next.js 16 (App Router) / TypeScript / Tailwind CSS 4 / Radix UI / xterm.js
- **Database:** SQLite3 (`/data/db.sqlite3`)
- **Cache/Channels:** Redis
- **Auth:** Google OAuth2 + JWT (simplejwt) + Session auth
- **Infra:** Docker Compose / Traefik v3 (reverse proxy) / Supervisor (process manager)
- **SSH:** linuxserver/openssh-server
- **Browser:** KasmVNC + Chromium in the `kasm-browser` container (per-session Xkasmvnc, WS↔WS relay through Django; the frontend uses the vendored KasmVNC noVNC fork in `src/frontend/src/vendor/kasm-novnc/`)

## Project Structure

```
src/
  backend/          # Django project
    backend/        # Django settings, urls, asgi config
    tunnels/        # Core tunnel CRUD, WebSocket terminal, permissions
    custom_auth/    # Authentication logic
    custom_jwt/     # JWT token handling
    login/          # Login views (Google OAuth)
    authorized_keys/ # SSH authorized keys management
    reverse_keys/   # Reverse tunnel key management
    web_sftp/       # SFTP-based file manager
    logs/           # Log viewing API
    user_management/ # User admin
    site_settings/  # Site configuration
    services/       # Service layer (remote browser, etc.)
    common/         # Shared utilities
  frontend/         # Next.js app
    src/app/        # Pages: login, first-login, tunnels (create/index/terminal/settings/logs/keys); root page.tsx redirects by auth state
    src/components/ # UI components (Shadcn-style + Radix)
    src/fonts/      # Local font files (loaded via next/font/local)
    src/hooks/      # Custom React hooks (WebSocket, notifications, etc.)
    src/lib/        # API client, auth, WebSocket, i18n, utilities
    src/locales/    # i18n dictionaries: en.ts (key source of truth), zh-TW.ts, ja.ts
    src/types/      # TypeScript type definitions
  configs/          # Traefik, Nginx, Supervisor configs
  scripts/          # Utility shell scripts
ssh/                # SSH keys and custom scripts
dev-scripts/        # Development helper scripts (.sh + .ps1)
```

## Development Commands

### Docker (primary workflow)

```bash
# Start all services
docker compose up -d --build

# Rebuild specific service
docker compose up -d --build backend
docker compose up -d --build frontend
```

### CLI wrapper (`telepy.sh`)

```bash
./telepy.sh keygen            # Generate SSH keys
./telepy.sh create-superuser  # Create Django admin (first user = superuser)
./telepy.sh shell             # Shell into backend container
./telepy.sh ipython           # IPython shell in backend
./telepy.sh supervisorctl     # Supervisor control shell
./telepy.sh ssh-shell         # Shell into SSH container
./telepy.sh migration         # Run Django migrations
./telepy.sh collect-static    # Collect static files
./telepy.sh backend-debug     # Recreate and attach to backend container
./telepy.sh django-startapp   # Create a new Django app
```

### Backend (inside container)

```bash
python manage.py test                     # Run all tests
python manage.py test tunnels.tests       # Run specific app tests
python manage.py makemigrations           # Create migrations
python manage.py migrate                  # Apply migrations
python manage.py collectstatic --noinput  # Collect static files
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
- `DEBUG` — Django debug mode (default: `false`)
- `WEB_SERVER_PORT` — Traefik exposed port (default: `8787`)
- `REVERSE_SERVER_SSH_PORT` — SSH tunnel port (default: `24242`)
- `SOCIAL_GOOGLE_CLIENT_ID` — Google OAuth client ID
- `SERVER_DOMAIN` — server hostname (default: `localhost`)
- `INTERNAL_API_TOKEN` — secret for internal API communication

## Architecture Notes

- **Services:** 6 containers orchestrated via Docker Compose: Traefik, frontend, backend, Redis, SSH, kasm-browser (remote browser)
- **Routing:** Traefik routes `/api/*`, `/ws/*`, and a fixed set of `/tunnels/{share,unshare,shared-users,available-users,update-permission,server}` paths to the backend; everything else to the frontend. Traefik also applies a `compress` middleware (gzip/brotli) to all HTTP routers (not `/ws`), since Django/gunicorn don't compress responses themselves.
- **WebSocket:** Terminal PTY via `channels` AsyncWebsocketConsumer, auth via JWT subprotocol
- **Permissions:** Hierarchical tunnel access — VIEW / EDIT / ADMIN — managed by `TunnelPermissionService`
- **Process management:** Supervisor runs the backend ASGI server (dev `DEBUG=true` → `manage.py runserver`, with daphne from `INSTALLED_APPS` providing ASGI/WebSocket; prod → gunicorn managing uvicorn workers — see `src/scripts/start-backend.sh`) plus the `websocket_update_ports` background worker, inside the backend container
- **API docs:** Swagger UI at `/api/__hidden_swagger`, ReDoc at `/api/__hidden_redoc` (requires auth)
- **TLS / deployment:** prod is assumed to sit behind an upstream TLS-terminating proxy (Cloudflare / Nginx / LB) that speaks HTTP/2 to browsers and forwards `http` to Traefik `:80`. Traefik's `web` entrypoint sets `forwardedHeaders.insecure: true` to preserve the upstream's `X-Forwarded-Proto`, and Django sets `SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https')` so it detects HTTPS correctly. If Traefik `:80` is reachable from untrusted networks, switch `insecure: true` → `trustedIPs`.
- **Startup / health:** the backend container runs `collectstatic` + `migrate` on start (NOT `makemigrations` — migrations are committed with the code) then supervisord. It exposes a public health endpoint `GET /api/auth/setup-status`; the compose `healthcheck` and Traefik `backend-service` `healthCheck` both use it so no `/api` request is routed before the ASGI server is listening (avoids post-deploy 502s).
- **Tunnels list data:** the list page loads via a single `GET /api/reverse/server/dashboard` returning `{tunnels, ports, latency}` in one authenticated round-trip (collapses the older keys+ports+latency fan-out). The tunnels-list serializer avoids N+1 by precomputing a per-tunnel permission map + share counts in the view (`tunnel_permission_context`).
- **Logging:** Loguru with timed rotating file handler + database logging
- **Static files:** WhiteNoise in production

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
  model (`/api/user/settings`; also included in `/api/auth/user/profile` as `language`,
  `null` = never chosen → the frontend pushes its local preference up; see `UserSettingsSync`
  in `lib/i18n.tsx`).
- **Switcher locations:** sidebar footer — four inline buttons (Auto/EN/繁/日,
  `components/layout/LanguageSwitcher.tsx`; the sidebar is collapsible — state in localStorage
  `telepy.sidebarCollapsed`) — and the user-preferences modal (gear button in the sidebar
  footer, `components/layout/UserPreferencesModal.tsx`). Admins can also set a user's language
  via Settings → Users → Manage modal (`/api/user/users`, `/api/user/users/<id>`).
- **Other user preferences** (`lib/userPrefs.ts` + `UserSettings` backend fields): `theme`
  (system/light/dark; class-based Tailwind dark mode, applied pre-paint by the same inline
  script from localStorage `telepy.theme`) and `terminal_font_size` (localStorage
  `telepy.terminalFontSize`; xterm reads it at init and live-applies via the
  `telepy:terminal-font-size` CustomEvent). Both sync server-side via `/api/user/settings`.
- **Site-setting labels/descriptions:** the settings page prefers dictionary keys
  `siteSettings.<field>.label` / `siteSettings.<field>.description` (localized), falling back
  to backend model `help_text` when the key is missing. **When adding a `SiteSettings` field,
  also add these two keys to all three dictionaries.**
- The Settings page (`/tunnels/settings`) is admin-only (Site Settings + Users tabs); personal
  preferences live in the sidebar gear modal.

### Rules when changing UI

1. **Add/change a string:** add or edit the key in `en.ts` FIRST, then mirror it in `zh-TW.ts` and
   `ja.ts` (TypeScript fails the build until all three agree). Then use `t("the.key")` in code.
2. **Remove UI:** delete its keys from all three dictionaries (unused keys rot; the extra-key
   check only catches keys missing from zh-TW/ja, not orphans in en).
3. **Do NOT translate:** keycap glyphs (Esc/Tab/Ctrl/F1…), format examples in placeholders
   (`ssh-rsa AAAA…`, `22`), code/paths inside `<code>` (pass them as `tn()` vars), size units,
   product names (SSH, PowerShell, AutoSSH, Docker), the Telepy brand, and the logs-page keyword
   filter chips (they string-match raw English sshd log content).
4. Backend-provided text (server error `detail` fields, log lines) is NOT frontend-translated —
   it renders verbatim. Exceptions with a mapping layer: site-setting labels/descriptions use
   the `siteSettings.<field>.*` keys (fallback = backend `help_text`), and remote-browser start
   errors with a machine-readable `code` (e.g. `device_offline`) map to `browser.*` keys.
5. Locale-aware formatting: use `useI18n().locale` for `Date.toLocaleString()` /
   `Intl.DateTimeFormat` instead of hardcoding `'en-US'`.
6. `metadata` in `app/layout.tsx` deliberately stays English (localizing it would force dynamic
   rendering for every route).

## Code Conventions

- Backend API views use DRF `APIView` with `@swagger_auto_schema()` decorators
- Business logic lives in service classes (e.g., `TunnelPermissionService`)
- Frontend uses centralized `apiFetch()` with auto JWT injection and 401 handling
- **All frontend UI strings go through i18n (`useI18n().t` / `tn`) — see the i18n section above**
- Comments are mixed English and Traditional Chinese
- Django apps follow standard layout: `models.py`, `views.py`, `urls.py`, `serializers.py`, `admin.py`
- Frontend components follow Shadcn/Radix patterns with `class-variance-authority`
