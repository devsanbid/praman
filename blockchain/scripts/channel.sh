#!/bin/sh
# Runs inside the fabric-tools CLI container after identities exist.
set -eu

cd /work
export FABRIC_CFG_PATH=/work/config
mkdir -p /work/channel-artifacts

if [ -f /work/channel-artifacts/certchannel.block ]; then
  echo "Using the existing certchannel genesis block"
else
  echo "Generating channel genesis block"
  configtxgen -profile CertChannel -outputBlock /work/channel-artifacts/certchannel.block -channelID certchannel
fi

echo "Joining orderer to certchannel"
orderer_ca=/work/organizations/ordererOrganizations/certnet.local/orderers/orderer.certnet.local/tls/ca.crt
orderer_cert=/work/organizations/ordererOrganizations/certnet.local/orderers/orderer.certnet.local/tls/server.crt
orderer_key=/work/organizations/ordererOrganizations/certnet.local/orderers/orderer.certnet.local/tls/server.key
if osnadmin channel list -o orderer.certnet.local:7053 --ca-file "$orderer_ca" --client-cert "$orderer_cert" --client-key "$orderer_key" | grep -q certchannel; then
  echo "Orderer already has certchannel"
else
  osnadmin channel join \
    --channelID certchannel \
    --config-block /work/channel-artifacts/certchannel.block \
    -o orderer.certnet.local:7053 \
    --ca-file "$orderer_ca" \
    --client-cert "$orderer_cert" \
    --client-key "$orderer_key"
fi

export CORE_PEER_TLS_ENABLED=true
export FABRIC_CFG_PATH=/etc/hyperledger/fabric

use_platform() {
  export CORE_PEER_LOCALMSPID=PlatformMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=/work/organizations/peerOrganizations/platform.certnet.local/peers/peer0.platform.certnet.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=/work/organizations/peerOrganizations/platform.certnet.local/users/Admin@platform.certnet.local/msp
  export CORE_PEER_ADDRESS=peer0.platform.certnet.local:7051
}

use_issuer() {
  export CORE_PEER_LOCALMSPID=IssuerMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=/work/organizations/peerOrganizations/issuers.certnet.local/peers/peer0.issuers.certnet.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=/work/organizations/peerOrganizations/issuers.certnet.local/users/Admin@issuers.certnet.local/msp
  export CORE_PEER_ADDRESS=peer0.issuers.certnet.local:9051
}

echo "Joining peers"
join_if_needed() {
  if peer channel list 2>/dev/null | grep -q certchannel; then
    echo "$CORE_PEER_ADDRESS already joined certchannel"
  else
    peer channel join -b /work/channel-artifacts/certchannel.block
  fi
}
use_platform
join_if_needed
use_issuer
join_if_needed

echo "Packaging chaincode"
pkg=/work/channel-artifacts/pkg
rm -rf "$pkg"
mkdir -p "$pkg"
cp /work/chaincode/connection.json "$pkg/connection.json"
cp /work/chaincode/metadata.json "$pkg/metadata.json"
tar -C "$pkg" -czf "$pkg/code.tar.gz" connection.json
tar -C "$pkg" -czf /work/channel-artifacts/certregistry.tgz code.tar.gz metadata.json

install_package() {
  set +e
  output=$(peer lifecycle chaincode install /work/channel-artifacts/certregistry.tgz 2>&1)
  code=$?
  set -e
  printf '%s\n' "$output"
  if [ "$code" -ne 0 ]; then
    if ! printf '%s\n' "$output" | grep -q "already successfully installed"; then
      exit "$code"
    fi
  fi
}

echo "Installing chaincode on both peers"
use_platform
install_package
use_issuer
install_package
peer lifecycle chaincode queryinstalled > /work/channel-artifacts/installed.txt
pkgid=$(sed -n 's/.*Package ID: \(certregistry_1.0.0:[a-f0-9][a-f0-9]*\).*/\1/p' /work/channel-artifacts/installed.txt | head -n 1)
if [ -z "$pkgid" ]; then
  echo "Could not read chaincode package id" >&2
  cat /work/channel-artifacts/installed.txt >&2
  exit 1
fi
printf '%s\n' "$pkgid" > /work/channel-artifacts/package.id
echo "Package ID $pkgid"
