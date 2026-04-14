# CLAUDE.md — Telepy

## Project Overview

Telepy is a full-stack web application for managing reverse SSH tunnels. It provides a web UI for creating/managing tunnels, a WebSocket-based terminal console, SFTP file management, remote browser sessions (Selenium), and tunnel sharing with permission controls.

## Tech Stack

- **Backend:** Python 3.11 / Django 5.0.6 / Django REST Framework / Daphne (ASGI) / Channels (WebSocket)
- **Frontend:** Next.js 16 (App Router) / TypeScript / Tailwind CSS 4 / Radix UI / xterm.js
- **Database:** SQLite3 (`/data/db.sqlite3`)
- **Cache/Channels:** Redis
- **Auth:** Google OAuth2 + JWT (simplejwt) + Session auth
- **Infra:** Docker Compose / Traefik v3 (reverse proxy) / Supervisor (process manager)
- **SSH:** linuxserver/openssh-server
- **Browser:** Selenium standalone-chromium

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
    src/app/        # Pages: login, tunnels (create/index/terminal/settings/logs/keys)
    src/components/ # UI components (Shadcn-style + Radix)
    src/fonts/      # Local font files (loaded via next/font/local)
    src/hooks/      # Custom React hooks (WebSocket, notifications, etc.)
    src/lib/        # API client, auth, WebSocket, utilities
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

- **Services:** 6 containers orchestrated via Docker Compose: Traefik, frontend, backend, Redis, SSH, Selenium
- **Routing:** Traefik routes `/api/*` and `/ws/*` to backend, everything else to frontend
- **WebSocket:** Terminal PTY via `channels` AsyncWebsocketConsumer, auth via JWT subprotocol
- **Permissions:** Hierarchical tunnel access — VIEW / EDIT / ADMIN — managed by `TunnelPermissionService`
- **Process management:** Supervisor runs Django (Daphne) and background WebSocket update workers inside the backend container
- **API docs:** Swagger UI at `/api/__hidden_swagger`, ReDoc at `/api/__hidden_redoc` (requires auth)
- **Logging:** Loguru with timed rotating file handler + database logging
- **Static files:** WhiteNoise in production

## Fonts

- **Chinese (CJK):** jf-openhuninn (`src/frontend/src/fonts/jf-openhuninn-2.1.ttf`) — used as primary `font-sans`
- **Terminal / Monospace:** 0xProto Nerd Font (`src/frontend/src/fonts/0xProtoNerdFont-Regular.ttf`) — used as primary `font-mono` and xterm.js terminal font
- Source font files also kept in project root `font/` directory
- Loaded via `next/font/local` in `layout.tsx` with `display: "block"` (fonts must finish downloading before rendering)
- Tailwind CSS variables `--font-sans` / `--font-mono` reference custom fonts first, then Geist as fallback
- xterm.js reads the terminal font name from CSS variable `--font-0xproto` via `getComputedStyle(document.body)` and awaits `document.fonts.ready` before initialization

## Code Conventions

- Backend API views use DRF `APIView` with `@swagger_auto_schema()` decorators
- Business logic lives in service classes (e.g., `TunnelPermissionService`)
- Frontend uses centralized `apiFetch()` with auto JWT injection and 401 handling
- Comments are mixed English and Traditional Chinese
- Django apps follow standard layout: `models.py`, `views.py`, `urls.py`, `serializers.py`, `admin.py`
- Frontend components follow Shadcn/Radix patterns with `class-variance-authority`
