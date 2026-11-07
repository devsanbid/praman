#!/bin/sh
# Runs inside the fabric-tools CLI container after chaincode servers are listening.
set -eu

cd /work
export FABRIC_CFG_PATH=/etc/hyperledger/fabric
pkgid=$(cat /work/channel-artifacts/package.id)
orderer_ca=/work/organizations/ordererOrganizations/certnet.local/orderers/orderer.certnet.local/tls/ca.crt
platform_tls=/work/organizations/peerOrganizations/platform.certnet.local/peers/peer0.platform.certnet.local/tls/ca.crt
issuer_tls=/work/organizations/peerOrganizations/issuers.certnet.local/peers/peer0.issuers.certnet.local/tls/ca.crt
policy="AND('PlatformMSP.peer','IssuerMSP.peer')"

export CORE_PEER_TLS_ENABLED=true

use_platform() {
  export CORE_PEER_LOCALMSPID=PlatformMSP
  export CORE_PEER_TLS_ROOTCERT_FILE="$platform_tls"
  export CORE_PEER_MSPCONFIGPATH=/work/organizations/peerOrganizations/platform.certnet.local/users/Admin@platform.certnet.local/msp
  export CORE_PEER_ADDRESS=peer0.platform.certnet.local:7051
}

use_issuer() {
  export CORE_PEER_LOCALMSPID=IssuerMSP
  export CORE_PEER_TLS_ROOTCERT_FILE="$issuer_tls"
  export CORE_PEER_MSPCONFIGPATH=/work/organizations/peerOrganizations/issuers.certnet.local/users/Admin@issuers.certnet.local/msp
  export CORE_PEER_ADDRESS=peer0.issuers.certnet.local:9051
}

use_platform
if peer lifecycle chaincode querycommitted --channelID certchannel --name certregistry 2>/dev/null | grep -q "Sequence: 1,"; then
  echo "Chaincode definition is already committed"
else
  echo "Approving chaincode definition"
  peer lifecycle chaincode approveformyorg \
    -o orderer.certnet.local:7050 \
    --tls --cafile "$orderer_ca" \
    --ordererTLSHostnameOverride orderer.certnet.local \
    --channelID certchannel --name certregistry --version 1.0.0 \
    --package-id "$pkgid" --sequence 1 \
    --signature-policy "$policy"

  use_issuer
  peer lifecycle chaincode approveformyorg \
    -o orderer.certnet.local:7050 \
    --tls --cafile "$orderer_ca" \
    --ordererTLSHostnameOverride orderer.certnet.local \
    --channelID certchannel --name certregistry --version 1.0.0 \
    --package-id "$pkgid" --sequence 1 \
    --signature-policy "$policy"

  echo "Committing chaincode definition"
  peer lifecycle chaincode commit \
    -o orderer.certnet.local:7050 \
    --tls --cafile "$orderer_ca" \
    --ordererTLSHostnameOverride orderer.certnet.local \
    --channelID certchannel --name certregistry --version 1.0.0 --sequence 1 \
    --signature-policy "$policy" \
    --peerAddresses peer0.platform.certnet.local:7051 --tlsRootCertFiles "$platform_tls" \
    --peerAddresses peer0.issuers.certnet.local:9051 --tlsRootCertFiles "$issuer_tls"
fi

echo "Waiting for peers to connect to chaincode"
sleep 4

use_platform
peer chaincode invoke \
  -o orderer.certnet.local:7050 \
  --tls --cafile "$orderer_ca" \
  --ordererTLSHostnameOverride orderer.certnet.local \
  -C certchannel -n certregistry \
  --peerAddresses peer0.platform.certnet.local:7051 --tlsRootCertFiles "$platform_tls" \
  --peerAddresses peer0.issuers.certnet.local:9051 --tlsRootCertFiles "$issuer_tls" \
  -c '{"function":"Ping","Args":[]}' \
  --waitForEvent

echo "Chaincode commit smoke test passed"
