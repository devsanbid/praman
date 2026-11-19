#!/usr/bin/env bash
# Bring up the permissioned Fabric network, deploy certregistry, and smoke-test Ping.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

ensure_secret() {
  local key="$1"
  local current
  current="$(grep -E "^${key}=" .env | head -n 1 | cut -d= -f2- || true)"
  if [[ -z "${current}" ]]; then
    local value
    value="$(openssl rand -hex 24)"
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      echo "${key}=${value}" >> .env
    fi
    echo "Generated ${key} in .env"
  fi
}

ensure_secret CA_PLATFORM_ADMIN_USER
ensure_secret CA_PLATFORM_ADMIN_PASSWORD
ensure_secret CA_ISSUER_ADMIN_USER
ensure_secret CA_ISSUER_ADMIN_PASSWORD
ensure_secret CA_ORDERER_ADMIN_USER
ensure_secret CA_ORDERER_ADMIN_PASSWORD
ensure_secret SESSION_SECRET
ensure_secret ADMIN_PASSWORD
ensure_secret POSTGRES_PASSWORD

# shellcheck disable=SC1091
set -a
source .env
set +a

if [[ -z "${DATABASE_URL}" ]]; then
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?schema=public"
  if grep -qE '^DATABASE_URL=' .env; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env
  else
    echo "DATABASE_URL=${DATABASE_URL}" >> .env
  fi
  echo "Set DATABASE_URL for localhost Postgres"
fi

# CA bootstrap names are identities, not secrets. Keep them stable if a password was filled alone.
if [[ -z "${CA_PLATFORM_ADMIN_USER}" ]]; then echo "CA_PLATFORM_ADMIN_USER is empty" >&2; exit 1; fi

compose() {
  docker compose --env-file "$ROOT/.env" -f "$ROOT/blockchain/docker-compose.fabric.yaml" "$@"
}

echo "Starting Fabric certificate authorities"
compose up -d \
  ca.platform.certnet.local \
  ca.issuers.certnet.local \
  ca.orderer.certnet.local

if [[ -f "$ROOT/blockchain/organizations/gateway-tls-ca.pem" ]]; then
  echo "Network identities already exist; skipping enrollment"
else
  echo "Enrolling network identities"
  docker run --rm --network praman_fabric \
    -v "$ROOT/blockchain:/work" \
    -e CA_PLATFORM_ADMIN_USER -e CA_PLATFORM_ADMIN_PASSWORD \
    -e CA_ISSUER_ADMIN_USER -e CA_ISSUER_ADMIN_PASSWORD \
    -e CA_ORDERER_ADMIN_USER -e CA_ORDERER_ADMIN_PASSWORD \
    --entrypoint sh \
    hyperledger/fabric-ca:1.5.15 \
    /work/scripts/enroll.sh
fi

docker run --rm --entrypoint chmod \
  -v "$ROOT/blockchain/organizations:/orgs" \
  hyperledger/fabric-ca:1.5.15 \
  -R a+rX /orgs

echo "Starting orderer, peers, and CLI"
compose up -d \
  orderer.certnet.local \
  peer0.platform.certnet.local \
  peer0.issuers.certnet.local \
  cli

echo "Waiting for the ordering service admin endpoint"
for _ in $(seq 1 40); do
  if docker exec praman.cli sh -c 'command -v osnadmin >/dev/null'; then
    break
  fi
  sleep 1
done
sleep 5

docker exec praman.cli sh /work/scripts/channel.sh

echo "Building chaincode image"
# Compile inside the Go image. The host Go is often older than go.mod, and
# Ubuntu's Go refuses to download the newer toolchain.
chaincode_dir="$ROOT/blockchain/chaincode/certregistry"
mkdir -p "$chaincode_dir/bin"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e CGO_ENABLED=0 \
  -e GOOS=linux \
  -e GOCACHE=/tmp/go-cache \
  -e GOPATH=/tmp/go \
  -e GOFLAGS=-mod=readonly \
  -v "$chaincode_dir":/src \
  -w /src \
  golang:1.23-bookworm \
  go build -o bin/certregistry .
docker build -t praman-certregistry:local "$chaincode_dir"

CHAINCODE_ID="$(tr -d '[:space:]' < "$ROOT/blockchain/channel-artifacts/package.id")"
export CHAINCODE_ID
echo "Starting chaincode servers for ${CHAINCODE_ID}"
docker compose --env-file "$ROOT/.env" -f "$ROOT/blockchain/docker-compose.chaincode.yaml" up -d

for _ in $(seq 1 30); do
  if docker exec praman.cli sh -c 'getent hosts chaincode.platform >/dev/null && getent hosts chaincode.issuers >/dev/null'; then
    break
  fi
  sleep 1
done

docker exec praman.cli sh /work/scripts/commit.sh

if ! grep -q 'peer0.platform.certnet.local' /etc/hosts 2>/dev/null; then
  echo "Optional: add these names to /etc/hosts if you run the API on the host rather than in Docker:"
  echo "  127.0.0.1 peer0.platform.certnet.local peer0.issuers.certnet.local orderer.certnet.local ca.issuers.certnet.local ca.platform.certnet.local"
fi

echo "Fabric network is up. Channel certchannel, chaincode certregistry."
