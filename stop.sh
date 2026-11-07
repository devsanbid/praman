#!/usr/bin/env bash
# Stop every Praman container. The database and Fabric identities stay on disk.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

env_args=()
if [[ -f "$ROOT/.env" ]]; then
  env_args=(--env-file "$ROOT/.env")
fi

echo "Stopping the website, API, and database"
docker compose "${env_args[@]}" stop

echo "Stopping chaincode"
docker compose "${env_args[@]}" -f "$ROOT/blockchain/docker-compose.chaincode.yaml" stop

echo "Stopping Fabric peers, orderer, and certificate authorities"
docker compose "${env_args[@]}" -f "$ROOT/blockchain/docker-compose.fabric.yaml" stop

echo "Praman containers are stopped. Start them again with: bash install.sh"
