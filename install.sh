#!/usr/bin/env bash
# One command to start Praman: Fabric, database, API, and website.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Install $1, then run this script again." >&2
    exit 1
  fi
}

need docker
need openssl
need go
need curl
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the Docker daemon is not running." >&2
  exit 1
fi

bash "$ROOT/scripts/fabric-up.sh"

echo "Starting PostgreSQL, the API, and the website"
docker compose --env-file "$ROOT/.env" up -d --build

echo "Waiting until the API can reach the ledger"
ready=0
for _ in $(seq 1 90); do
  body="$(curl -fsS http://127.0.0.1:4000/api/v1/health 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"chainReachable":true'; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" -ne 1 ]]; then
  echo "The API did not report a reachable ledger. Recent API logs:" >&2
  docker logs praman-backend-1 --tail 40 >&2 || true
  exit 1
fi

cat <<'EOF'

Praman is running.
  Website:  http://localhost:8080
  API docs: http://localhost:8080/api/docs

Click a card on the home page to sign in.
Every demo account uses the password PramanDemo2082.

Stop the containers with:
  bash stop.sh
EOF
