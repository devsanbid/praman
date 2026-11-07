#!/usr/bin/env bash
# Tear down the Fabric network and remove CA material, including files owned by the container user.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

compose_env=()
if [[ -f "$ROOT/.env" ]]; then
  compose_env=(--env-file "$ROOT/.env")
fi

docker compose "${compose_env[@]}" -f "$ROOT/blockchain/docker-compose.chaincode.yaml" down --remove-orphans || true
docker compose "${compose_env[@]}" -f "$ROOT/blockchain/docker-compose.fabric.yaml" down -v --remove-orphans || true

if [[ -d "$ROOT/blockchain/organizations" || -d "$ROOT/blockchain/channel-artifacts" ]]; then
  docker run --rm --entrypoint sh \
    -v "$ROOT/blockchain:/work" \
    hyperledger/fabric-ca:1.5.15 \
    -c 'rm -rf /work/organizations /work/channel-artifacts'
fi

docker network rm praman_fabric >/dev/null 2>&1 || true
echo "Fabric network removed."
