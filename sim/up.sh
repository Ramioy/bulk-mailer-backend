#!/usr/bin/env bash
# Starts the simulated environment from scratch (empty database): data, secrets, TLS, image and containers.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=sim/out
COMPOSE=(docker compose -f sim/docker-compose.yml --env-file "$OUT/sim.env")

mkdir -p "$OUT/tls" "$OUT/control"
rm -f "$OUT"/control/*
node sim/generate.ts "$OUT"

if [ ! -f "$OUT/sim.env" ]; then
  secret() { openssl rand -hex 24; }
  cat > "$OUT/sim.env" <<ENV
OWNER_DB_PASSWORD=$(secret)
APP_DB_PASSWORD=$(secret)
JWT_SIGNING_KEY=$(openssl rand -base64 32)
TAYRONA_API_TOKEN=$(secret)
SAP_API_TOKEN=$(secret)
ZEPTOMAIL_API_KEY=$(secret)
ZOHO_OAUTH_CLIENT_ID=sim-client
ZOHO_OAUTH_CLIENT_SECRET=$(secret)
ZOHO_OAUTH_REFRESH_TOKEN=$(secret)
ZEPTO_OAUTH_TOKEN=$(secret)
ZEPTOMAIL_WEBHOOK_KEY=$(secret)
ZEPTOMAIL_WEBHOOK_AUTHORIZATION=Webhook-$(secret)
SIM_OPERATOR=operador
SIM_OPERATOR_PASSWORD=$(secret)
ENV
fi
if [ ! -f "$OUT/tls/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=app" \
    -addext "subjectAltName=DNS:app,DNS:app2,DNS:localhost,IP:127.0.0.1" \
    -keyout "$OUT/tls/key.pem" -out "$OUT/tls/cert.pem" 2>/dev/null
  chmod 644 "$OUT/tls/key.pem"
fi

pnpm -s build
docker build -q -f sim/Dockerfile -t bulk-mailer-sim . >/dev/null
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d app

for _ in $(seq 1 60); do
  if curl -sf --cacert "$OUT/tls/cert.pem" https://localhost:3443/health >/dev/null; then
    echo "Simulated environment ready: https://localhost:3443 (operator and secrets in $OUT/sim.env)"
    exit 0
  fi
  sleep 2
done
echo "The application did not become healthy; last logs:" >&2
"${COMPOSE[@]}" logs --tail 50 app >&2
exit 1
