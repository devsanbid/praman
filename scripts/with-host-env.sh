#!/usr/bin/env bash
# Export host paths for the API without printing secrets, then run the given command.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

export UPLOAD_DIR="$ROOT/storage/certificates"
export WALLET_DIR="$ROOT/storage/wallets"
export FABRIC_TLS_CERT_PATH="$ROOT/blockchain/organizations/gateway-tls-ca.pem"
export FABRIC_PLATFORM_CERT_PATH="$ROOT/blockchain/organizations/peerOrganizations/platform.certnet.local/users/Admin@platform.certnet.local/msp/signcerts/cert.pem"
export FABRIC_PLATFORM_KEY_PATH="$ROOT/blockchain/organizations/peerOrganizations/platform.certnet.local/users/Admin@platform.certnet.local/msp/keystore/key.pem"
export FABRIC_VERIFIER_CERT_PATH="$ROOT/blockchain/organizations/peerOrganizations/platform.certnet.local/users/Verifier@platform.certnet.local/msp/signcerts/cert.pem"
export FABRIC_VERIFIER_KEY_PATH="$ROOT/blockchain/organizations/peerOrganizations/platform.certnet.local/users/Verifier@platform.certnet.local/msp/keystore/key.pem"
export FABRIC_CA_TLS_CERT_PATH="$ROOT/blockchain/organizations/fabric-ca/issuers/tls-cert.pem"
export FABRIC_CA_REGISTRAR_CERT_PATH="$ROOT/blockchain/organizations/fabric-ca/issuers/registrar/cert.pem"
export FABRIC_CA_REGISTRAR_KEY_PATH="$ROOT/blockchain/organizations/fabric-ca/issuers/registrar/key.pem"
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}?schema=public"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:8080}"
export FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:8080}"

if ! grep -q 'peer0.platform.certnet.local' /etc/hosts 2>/dev/null; then
  echo "Add this line to /etc/hosts before using the API on the host:" >&2
  echo "  127.0.0.1 peer0.platform.certnet.local peer0.issuers.certnet.local orderer.certnet.local ca.issuers.certnet.local ca.platform.certnet.local" >&2
fi

exec "$@"
