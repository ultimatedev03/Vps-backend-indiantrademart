#!/usr/bin/env bash
set -Eeuo pipefail

BACKEND_DIR="${BACKEND_DIR:-/opt/indiantrademart-backend}"
BACKEND_ENV="${BACKEND_ENV:-$BACKEND_DIR/.env.local}"
OPENSEARCH_URL="${OPENSEARCH_URL:-http://127.0.0.1:9200}"
OPENSEARCH_INDEX="${OPENSEARCH_INDEX:-itm_products_v1}"
OPENSEARCH_CONTAINER="${OPENSEARCH_CONTAINER:-itm-opensearch}"
OPENSEARCH_IMAGE="${OPENSEARCH_IMAGE:-opensearchproject/opensearch:2}"
OPENSEARCH_HEAP="${OPENSEARCH_HEAP:-512m}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on the VPS."
  exit 1
fi

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

ensure_swap_for_small_vps() {
  local mem_mb
  mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  if [ "$mem_mb" -ge 1800 ] || swapon --show | grep -q '^'; then
    return
  fi

  echo "===== CREATE 2G SWAP FOR OPENSEARCH ====="
  if [ ! -f /swapfile-opensearch ]; then
    fallocate -l 2G /swapfile-opensearch 2>/dev/null || dd if=/dev/zero of=/swapfile-opensearch bs=1M count=2048
    chmod 600 /swapfile-opensearch
    mkswap /swapfile-opensearch
  fi
  swapon /swapfile-opensearch || true
  grep -q '/swapfile-opensearch' /etc/fstab || echo '/swapfile-opensearch none swap sw 0 0' >> /etc/fstab
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    return
  fi

  echo "===== INSTALL DOCKER ====="
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

start_opensearch() {
  echo "===== START OPENSEARCH ====="
  sysctl -w vm.max_map_count=262144 >/dev/null
  grep -q '^vm.max_map_count=262144' /etc/sysctl.conf || echo 'vm.max_map_count=262144' >> /etc/sysctl.conf

  docker pull "$OPENSEARCH_IMAGE"
  if docker ps -a --format '{{.Names}}' | grep -qx "$OPENSEARCH_CONTAINER"; then
    docker rm -f "$OPENSEARCH_CONTAINER" >/dev/null
  fi

  docker run -d \
    --name "$OPENSEARCH_CONTAINER" \
    --restart unless-stopped \
    --ulimit nofile=65536:65536 \
    -p 127.0.0.1:9200:9200 \
    -p 127.0.0.1:9600:9600 \
    -e discovery.type=single-node \
    -e DISABLE_SECURITY_PLUGIN=true \
    -e DISABLE_INSTALL_DEMO_CONFIG=true \
    -e bootstrap.memory_lock=false \
    -e "OPENSEARCH_JAVA_OPTS=-Xms${OPENSEARCH_HEAP} -Xmx${OPENSEARCH_HEAP}" \
    -v itm-opensearch-data:/usr/share/opensearch/data \
    "$OPENSEARCH_IMAGE" >/dev/null
}

wait_for_opensearch() {
  echo "===== WAIT FOR OPENSEARCH ====="
  for _ in $(seq 1 90); do
    if curl -fsS "$OPENSEARCH_URL" >/dev/null 2>&1; then
      echo "OpenSearch is ready at $OPENSEARCH_URL"
      return
    fi
    sleep 2
  done
  docker logs --tail 120 "$OPENSEARCH_CONTAINER" || true
  echo "OpenSearch did not become ready in time."
  exit 1
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

  echo "Backend service manager not found. Restart the backend manually."
}

echo "===== PREPARE OPENSEARCH DEPENDENCIES ====="
ensure_swap_for_small_vps
install_docker_if_missing
start_opensearch
wait_for_opensearch

echo "===== CONFIGURE BACKEND ENV ====="
set_env_var "$BACKEND_ENV" OPENSEARCH_ENABLED true
set_env_var "$BACKEND_ENV" OPENSEARCH_URL "$OPENSEARCH_URL"
set_env_var "$BACKEND_ENV" OPENSEARCH_INDEX "$OPENSEARCH_INDEX"
set_env_var "$BACKEND_ENV" OPENSEARCH_USERNAME ""
set_env_var "$BACKEND_ENV" OPENSEARCH_PASSWORD ""

echo "===== INSTALL BACKEND + REINDEX PRODUCTS ====="
cd "$BACKEND_DIR"
npm ci --omit=dev
npm run db:setup
npm run search:reindex -- --recreate --batch=250

restart_backend

echo "===== SMOKE TEST ====="
curl -fsS "$OPENSEARCH_URL" >/dev/null
curl -k -sS "https://api.indiantrademart.com/api/dir/autocomplete?q=shoes" | head -c 500 || true
echo
curl -k -sS "https://api.indiantrademart.com/api/dir/hybrid-search?q=shoes&limit=3" | head -c 700 || true
echo
echo "OpenSearch hybrid search setup complete."
