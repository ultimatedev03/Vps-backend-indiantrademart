#!/usr/bin/env bash
set -e

echo "===== UPDATE FRONTEND ====="
cd /opt/indiantrademart-frontend
git fetch origin
git pull --ff-only origin main
npm ci
npm run build
rsync -a --delete dist/ /var/www/indiantrademart/

echo "===== UPDATE BACKEND ====="
cd /opt/indiantrademart-backend
git fetch origin
git pull --ff-only origin main
npm ci --omit=dev

echo "===== ENSURE BACKEND EMAIL ENV ====="
if ! grep -q '^RESEND_API_KEY=' .env.local 2>/dev/null && ! grep -q '^GMAIL_EMAIL=' .env.local 2>/dev/null && ! grep -q '^SMTP_HOST=' .env.local 2>/dev/null; then
  cat <<'ENV_WARNING'
WARNING: backend/.env.local does not appear to contain email provider settings.
Add either Resend, Gmail, or SMTP values before testing buyer/vendor registration.
ENV_WARNING
fi

echo "===== RESTART SERVICES ====="
systemctl restart indiantrademart-backend
nginx -t
systemctl reload nginx

echo "===== CHECK ====="
systemctl status indiantrademart-backend --no-pager
curl -fsS http://127.0.0.1:3100/health || true
curl -I https://indiantrademart.com
curl -I https://api.indiantrademart.com/health || true
