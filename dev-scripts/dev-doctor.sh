#!/bin/bash
# 主機端健康檢查：.env、容器、對外的網頁與 gateway 埠，再跑後端容器裡的 `telepy-server doctor`。
# Host-side health check: .env, containers, the published web and gateway ports, then the in-container doctor.

source "$(dirname "$0")/common.sh"

FAILED=0
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=1; }

print_message "$BLUE" "Host"
if [ -f .env ]; then ok ".env found"; else fail ".env is missing (copy .env.example)"; fi
for var in PROJECT_NAME WEB_SERVER_PORT REVERSE_SERVER_SSH_PORT SERVER_DOMAIN; do
    if [ -n "${!var}" ]; then ok "$var=${!var}"; else fail "$var is empty in .env"; fi
done
if [ -z "$SECRET_KEY" ]; then warn "SECRET_KEY is empty: the legacy default signs login tokens"; else ok "SECRET_KEY is set"; fi
if [ -z "$INTERNAL_API_TOKEN" ]; then warn "INTERNAL_API_TOKEN is empty"; else ok "INTERNAL_API_TOKEN is set"; fi
for f in ssh/ssh_host_keys/ssh_host_ed25519_key ssh/backend_ssh_key/id_rsa ssh/backend_ssh_key/id_rsa.pub; do
    if [ -f "$f" ]; then ok "$f"; else fail "$f is missing (run ./telepy.sh keygen)"; fi
done

print_message "$BLUE" "Containers"
if ! docker info >/dev/null 2>&1; then
    fail "cannot talk to Docker"
else
    for svc in traefik frontend backend kasm-browser guacd; do
        state=$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$svc" '$1 == s {print $2, $3}')
        case "$state" in
            "running healthy"|"running ") ok "$svc running" ;;
            running*) ok "$svc running ($state)" ;;
            "") if [ "$svc" = "guacd" ]; then warn "guacd is not running (remote desktop will not work)"; else fail "$svc is not running"; fi ;;
            *) fail "$svc: $state" ;;
        esac
    done
fi

print_message "$BLUE" "Network"
if curl -fsS -o /dev/null --max-time 5 "http://localhost:${WEB_SERVER_PORT}/api/auth/setup-status"; then
    ok "web UI and API answer on :${WEB_SERVER_PORT}"
else
    fail "nothing answers on http://localhost:${WEB_SERVER_PORT}/api/auth/setup-status"
fi
if command -v ssh-keyscan >/dev/null 2>&1; then
    if [ -n "$(ssh-keyscan -T 5 -p "${REVERSE_SERVER_SSH_PORT}" localhost 2>/dev/null)" ]; then
        ok "SSH gateway answers on :${REVERSE_SERVER_SSH_PORT}"
    else
        fail "the SSH gateway does not answer on :${REVERSE_SERVER_SSH_PORT}"
    fi
else
    warn "ssh-keyscan not found; skipped the gateway port check"
fi

print_message "$BLUE" "Backend (inside ${CONTAINER_WEB_NAME})"
if docker exec "$CONTAINER_WEB_NAME" telepy-server doctor; then
    :
else
    code=$?
    if [ "$code" = "1" ]; then FAILED=1; else fail "could not run telepy-server doctor (exit $code); rebuild the backend image if it is older than this script"; fi
fi

echo
if [ "$FAILED" = "1" ]; then
    print_message "$RED" "Something needs fixing (✗ above)."
    exit 1
fi
print_message "$GREEN" "Nothing is broken. Warnings (!) are worth a look."
