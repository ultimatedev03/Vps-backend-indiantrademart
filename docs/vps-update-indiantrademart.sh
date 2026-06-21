#!/usr/bin/env bash
set -Eeuo pipefail

FRONTEND_DIR="${FRONTEND_DIR:-/opt/indiantrademart-frontend}"
BACKEND_DIR="${BACKEND_DIR:-/opt/indiantrademart-backend}"
WEB_ROOT="${WEB_ROOT:-/var/www/indiantrademart}"
BACKEND_ENV="${BACKEND_ENV:-$BACKEND_DIR/.env.local}"
FRONTEND_ENV="${FRONTEND_ENV:-$FRONTEND_DIR/.env.local}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-/root/itm-predeploy-$STAMP}"
SEARCH_RECREATE_INDEX="${SEARCH_RECREATE_INDEX:-true}"

mkdir -p "$BACKUP_DIR"

read_env_var() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | sed "s/^${key}=//"
}

set_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp

  mkdir -p "$(dirname "$file")"
  touch "$file"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

sync_repo() {
  local dir="$1"
  local name="$2"

  cd "$dir"
  echo "===== BACKUP $name ====="
  git status --short > "$BACKUP_DIR/$name-status.txt" || true
  git rev-parse HEAD > "$BACKUP_DIR/$name-head.txt" || true
  git branch "backup/predeploy-$name-$STAMP" HEAD >/dev/null 2>&1 || true

  mkdir -p "$BACKUP_DIR/$name-env"
  find . -maxdepth 2 -type f \( -name ".env" -o -name ".env.*" \) ! -name ".env.example" -exec cp -p {} "$BACKUP_DIR/$name-env/" \; 2>/dev/null || true

  if [ -n "$(git status --porcelain)" ]; then
    git diff > "$BACKUP_DIR/$name-working.patch" || true
    git diff --staged > "$BACKUP_DIR/$name-staged.patch" || true
    git stash push -u -m "predeploy-$name-$STAMP"
  fi

  echo "===== SYNC $name WITH GITHUB ====="
  git fetch origin main
  git reset --hard origin/main
}

configure_frontend_env() {
  echo "===== CONFIGURE FRONTEND ENV ====="
  local mysql_host mysql_port mysql_user mysql_password mysql_database
  mysql_host="$(read_env_var "$BACKEND_ENV" MYSQL_HOST)"
  mysql_port="$(read_env_var "$BACKEND_ENV" MYSQL_PORT)"
  mysql_user="$(read_env_var "$BACKEND_ENV" MYSQL_USER)"
  mysql_password="$(read_env_var "$BACKEND_ENV" MYSQL_PASSWORD)"
  mysql_database="$(read_env_var "$BACKEND_ENV" MYSQL_DATABASE)"

  set_env_var "$FRONTEND_ENV" VITE_API_URL "https://api.indiantrademart.com"
  set_env_var "$FRONTEND_ENV" VITE_SITE_URL "https://indiantrademart.com"
  set_env_var "$FRONTEND_ENV" MYSQL_HOST "${mysql_host:-127.0.0.1}"
  set_env_var "$FRONTEND_ENV" MYSQL_PORT "${mysql_port:-3306}"
  set_env_var "$FRONTEND_ENV" MYSQL_USER "${mysql_user:-root}"
  set_env_var "$FRONTEND_ENV" MYSQL_PASSWORD "${mysql_password:-}"
  set_env_var "$FRONTEND_ENV" MYSQL_DATABASE "${mysql_database:-indiantrademart}"
}

deploy_frontend_dist() {
  echo "===== DEPLOY FRONTEND DIST ====="
  local target="$WEB_ROOT"
  if nginx -T 2>/dev/null | grep -q "root $WEB_ROOT/frontend"; then
    target="$WEB_ROOT/frontend"
  fi
  mkdir -p "$target"
  rsync -a --delete "$FRONTEND_DIR/dist/" "$target/"
}

restart_backend() {
  echo "===== RESTART BACKEND ====="
  if systemctl list-unit-files | grep -q '^indiantrademart-backend.service'; then
    systemctl restart indiantrademart-backend
    systemctl is-active indiantrademart-backend
    return
  fi

  if command -v pm2 >/dev/null 2>&1 && pm2 describe indiantrademart-api >/dev/null 2>&1; then
    pm2 restart indiantrademart-api
    return
  fi

  echo "Backend service manager not found. Restart backend manually."
}

echo "===== BACKUP + UPDATE CODE ====="
sync_repo "$BACKEND_DIR" backend
sync_repo "$FRONTEND_DIR" frontend

echo "===== BACKEND INSTALL + DB MIGRATE ====="
cd "$BACKEND_DIR"
npm ci --omit=dev
npm run db:setup

if grep -q '^OPENSEARCH_ENABLED=true' "$BACKEND_ENV" 2>/dev/null; then
  echo "===== OPENSEARCH REINDEX ====="
  if [ "$SEARCH_RECREATE_INDEX" = "true" ]; then
    npm run search:reindex -- --recreate --batch=250
  else
    npm run search:reindex -- --batch=250
  fi
fi

configure_frontend_env

echo "===== FRONTEND INSTALL + BUILD ====="
cd "$FRONTEND_DIR"
npm ci
npm run build
deploy_frontend_dist

restart_backend
nginx -t
systemctl reload nginx

echo "===== CHECK ====="
curl -fsS http://127.0.0.1:3100/health || true
curl -k -sS -o /dev/null -w "site=%{http_code}\n" https://indiantrademart.com/
curl -k -sS -o /dev/null -w "api=%{http_code}\n" https://api.indiantrademart.com/health
curl -k -sS -o /dev/null -w "search=%{http_code}\n" "https://api.indiantrademart.com/api/dir/hybrid-search?q=shoes&limit=1" || true

echo "Backup saved at: $BACKUP_DIR"
