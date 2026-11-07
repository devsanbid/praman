#!/bin/sh
# Runs inside the fabric-ca image on the praman_fabric network.
# Creates peer, orderer, and application identities from the three Fabric CAs.
set -eu

ROOT=/work
cd "$ROOT"

wait_for_ca() {
  name="$1"
  file="$2"
  i=0
  while [ ! -f "$file" ]; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "Timed out waiting for $name CA certificate at $file" >&2
      exit 1
    fi
    sleep 1
  done
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
    return
  fi
  dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
}

quiet_register() {
  # fabric-ca-client prints the one-time enrollment secret. Keep it out of the log.
  out=$(fabric-ca-client register "$@" 2>&1) || {
    printf '%s\n' "$out" | grep -v '^Password:' >&2 || true
    return 1
  }
}

stable_pem() {
  dir="$1"
  dest="$2"
  if [ -f "$dest" ]; then
    return 0
  fi
  src=$(find "$dir" -type f | head -n 1)
  if [ -z "$src" ]; then
    echo "No PEM material in $dir" >&2
    exit 1
  fi
  cp "$src" "$dest"
}

retry() {
  n=0
  while true; do
    if "$@"; then
      return 0
    fi
    n=$((n + 1))
    if [ "$n" -gt 20 ]; then
      echo "Command failed after retries: $*" >&2
      return 1
    fi
    sleep 2
  done
}

write_nodeou() {
  msp="$1"
  ca_file=$(basename "$(find "$msp/cacerts" -type f -name '*.pem' | head -n 1)")
  cat > "$msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${ca_file}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${ca_file}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${ca_file}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${ca_file}
    OrganizationalUnitIdentifier: orderer
EOF
}

copy_tls() {
  tls="$1"
  stable_pem "$tls/tlscacerts" "$tls/ca.crt"
  stable_pem "$tls/signcerts" "$tls/server.crt"
  stable_pem "$tls/keystore" "$tls/server.key"
}

finish_identity_msp() {
  msp="$1"
  template="$2"
  cp "$template" "$msp/config.yaml"
  stable_pem "$msp/signcerts" "$msp/signcerts/cert.pem"
  stable_pem "$msp/keystore" "$msp/keystore/key.pem"
}

create_platform() {
  echo "Enrolling platform organization"
  org="$ROOT/organizations/peerOrganizations/platform.certnet.local"
  mkdir -p "$org"
  export FABRIC_CA_CLIENT_HOME="$org"
  tls_cert="$ROOT/organizations/fabric-ca/platform/tls-cert.pem"
  retry fabric-ca-client enroll \
    -u "https://${CA_PLATFORM_ADMIN_USER}:${CA_PLATFORM_ADMIN_PASSWORD}@ca.platform.certnet.local:7054" \
    --caname ca-platform \
    --tls.certfiles "$tls_cert"

  write_nodeou "$org/msp"
  mkdir -p "$org/msp/tlscacerts" "$org/tlsca" "$org/ca" \
    "$ROOT/organizations/fabric-ca/platform/registrar"
  cp "$ROOT/organizations/fabric-ca/platform/ca-cert.pem" "$org/msp/tlscacerts/ca.crt"
  cp "$ROOT/organizations/fabric-ca/platform/ca-cert.pem" "$org/tlsca/ca.crt"
  cp "$ROOT/organizations/fabric-ca/platform/ca-cert.pem" "$org/ca/ca.crt"
  stable_pem "$org/msp/signcerts" "$org/msp/signcerts/cert.pem"
  stable_pem "$org/msp/keystore" "$org/msp/keystore/key.pem"
  cp "$org/msp/signcerts/cert.pem" "$ROOT/organizations/fabric-ca/platform/registrar/cert.pem"
  cp "$org/msp/keystore/key.pem" "$ROOT/organizations/fabric-ca/platform/registrar/key.pem"

  peer_secret=$(rand_hex)
  admin_secret=$(rand_hex)
  verifier_secret=$(rand_hex)

  quiet_register --caname ca-platform --id.name peer0 --id.secret "$peer_secret" --id.type peer --id.affiliation org1 --tls.certfiles "$tls_cert"
  quiet_register --caname ca-platform --id.name platformadmin --id.secret "$admin_secret" --id.type admin --id.affiliation org1 --tls.certfiles "$tls_cert"
  quiet_register --caname ca-platform --id.name verifier --id.secret "$verifier_secret" --id.type client --id.affiliation org1 --tls.certfiles "$tls_cert"

  peer_msp="$org/peers/peer0.platform.certnet.local/msp"
  peer_tls="$org/peers/peer0.platform.certnet.local/tls"
  fabric-ca-client enroll -u "https://peer0:${peer_secret}@ca.platform.certnet.local:7054" --caname ca-platform -M "$peer_msp" --tls.certfiles "$tls_cert"
  fabric-ca-client enroll -u "https://peer0:${peer_secret}@ca.platform.certnet.local:7054" --caname ca-platform -M "$peer_tls" --enrollment.profile tls \
    --csr.hosts peer0.platform.certnet.local --csr.hosts localhost --tls.certfiles "$tls_cert"
  finish_identity_msp "$peer_msp" "$org/msp/config.yaml"
  copy_tls "$peer_tls"

  admin_msp="$org/users/Admin@platform.certnet.local/msp"
  fabric-ca-client enroll -u "https://platformadmin:${admin_secret}@ca.platform.certnet.local:7054" --caname ca-platform -M "$admin_msp" --tls.certfiles "$tls_cert"
  finish_identity_msp "$admin_msp" "$org/msp/config.yaml"

  verifier_msp="$org/users/Verifier@platform.certnet.local/msp"
  fabric-ca-client enroll -u "https://verifier:${verifier_secret}@ca.platform.certnet.local:7054" --caname ca-platform -M "$verifier_msp" --tls.certfiles "$tls_cert"
  finish_identity_msp "$verifier_msp" "$org/msp/config.yaml"
}

create_issuers() {
  echo "Enrolling issuer organization"
  org="$ROOT/organizations/peerOrganizations/issuers.certnet.local"
  mkdir -p "$org"
  export FABRIC_CA_CLIENT_HOME="$org"
  tls_cert="$ROOT/organizations/fabric-ca/issuers/tls-cert.pem"
  retry fabric-ca-client enroll \
    -u "https://${CA_ISSUER_ADMIN_USER}:${CA_ISSUER_ADMIN_PASSWORD}@ca.issuers.certnet.local:8054" \
    --caname ca-issuers \
    --tls.certfiles "$tls_cert"

  write_nodeou "$org/msp"
  mkdir -p "$org/msp/tlscacerts" "$org/tlsca" "$org/ca" \
    "$ROOT/organizations/fabric-ca/issuers/registrar"
  cp "$ROOT/organizations/fabric-ca/issuers/ca-cert.pem" "$org/msp/tlscacerts/ca.crt"
  cp "$ROOT/organizations/fabric-ca/issuers/ca-cert.pem" "$org/tlsca/ca.crt"
  cp "$ROOT/organizations/fabric-ca/issuers/ca-cert.pem" "$org/ca/ca.crt"
  stable_pem "$org/msp/signcerts" "$org/msp/signcerts/cert.pem"
  stable_pem "$org/msp/keystore" "$org/msp/keystore/key.pem"
  cp "$org/msp/signcerts/cert.pem" "$ROOT/organizations/fabric-ca/issuers/registrar/cert.pem"
  cp "$org/msp/keystore/key.pem" "$ROOT/organizations/fabric-ca/issuers/registrar/key.pem"

  peer_secret=$(rand_hex)
  admin_secret=$(rand_hex)
  quiet_register --caname ca-issuers --id.name peer0 --id.secret "$peer_secret" --id.type peer --id.affiliation org1 --tls.certfiles "$tls_cert"
  quiet_register --caname ca-issuers --id.name issueradmin --id.secret "$admin_secret" --id.type admin --id.affiliation org1 --tls.certfiles "$tls_cert"

  peer_msp="$org/peers/peer0.issuers.certnet.local/msp"
  peer_tls="$org/peers/peer0.issuers.certnet.local/tls"
  fabric-ca-client enroll -u "https://peer0:${peer_secret}@ca.issuers.certnet.local:8054" --caname ca-issuers -M "$peer_msp" --tls.certfiles "$tls_cert"
  fabric-ca-client enroll -u "https://peer0:${peer_secret}@ca.issuers.certnet.local:8054" --caname ca-issuers -M "$peer_tls" --enrollment.profile tls \
    --csr.hosts peer0.issuers.certnet.local --csr.hosts localhost --tls.certfiles "$tls_cert"
  finish_identity_msp "$peer_msp" "$org/msp/config.yaml"
  copy_tls "$peer_tls"

  admin_msp="$org/users/Admin@issuers.certnet.local/msp"
  fabric-ca-client enroll -u "https://issueradmin:${admin_secret}@ca.issuers.certnet.local:8054" --caname ca-issuers -M "$admin_msp" --tls.certfiles "$tls_cert"
  finish_identity_msp "$admin_msp" "$org/msp/config.yaml"
}

create_orderer() {
  echo "Enrolling ordering organization"
  org="$ROOT/organizations/ordererOrganizations/certnet.local"
  mkdir -p "$org"
  export FABRIC_CA_CLIENT_HOME="$org"
  tls_cert="$ROOT/organizations/fabric-ca/orderer/tls-cert.pem"
  retry fabric-ca-client enroll \
    -u "https://${CA_ORDERER_ADMIN_USER}:${CA_ORDERER_ADMIN_PASSWORD}@ca.orderer.certnet.local:9054" \
    --caname ca-orderer \
    --tls.certfiles "$tls_cert"

  write_nodeou "$org/msp"
  mkdir -p "$org/msp/tlscacerts" "$org/tlsca"
  cp "$ROOT/organizations/fabric-ca/orderer/ca-cert.pem" "$org/msp/tlscacerts/ca.crt"
  cp "$ROOT/organizations/fabric-ca/orderer/ca-cert.pem" "$org/tlsca/ca.crt"
  stable_pem "$org/msp/signcerts" "$org/msp/signcerts/cert.pem"
  stable_pem "$org/msp/keystore" "$org/msp/keystore/key.pem"

  orderer_secret=$(rand_hex)
  admin_secret=$(rand_hex)
  quiet_register --caname ca-orderer --id.name orderer --id.secret "$orderer_secret" --id.type orderer --id.affiliation org1 --tls.certfiles "$tls_cert"
  quiet_register --caname ca-orderer --id.name ordereradmin --id.secret "$admin_secret" --id.type admin --id.affiliation org1 --tls.certfiles "$tls_cert"

  orderer_msp="$org/orderers/orderer.certnet.local/msp"
  orderer_tls="$org/orderers/orderer.certnet.local/tls"
  fabric-ca-client enroll -u "https://orderer:${orderer_secret}@ca.orderer.certnet.local:9054" --caname ca-orderer -M "$orderer_msp" --tls.certfiles "$tls_cert"
  fabric-ca-client enroll -u "https://orderer:${orderer_secret}@ca.orderer.certnet.local:9054" --caname ca-orderer -M "$orderer_tls" --enrollment.profile tls \
    --csr.hosts orderer.certnet.local --csr.hosts localhost --tls.certfiles "$tls_cert"
  finish_identity_msp "$orderer_msp" "$org/msp/config.yaml"
  copy_tls "$orderer_tls"
  mkdir -p "$orderer_msp/tlscacerts"
  cp "$orderer_tls/ca.crt" "$orderer_msp/tlscacerts/ca.crt"

  admin_msp="$org/users/Admin@certnet.local/msp"
  fabric-ca-client enroll -u "https://ordereradmin:${admin_secret}@ca.orderer.certnet.local:9054" --caname ca-orderer -M "$admin_msp" --tls.certfiles "$tls_cert"
  finish_identity_msp "$admin_msp" "$org/msp/config.yaml"
}

wait_for_ca platform "$ROOT/organizations/fabric-ca/platform/tls-cert.pem"
wait_for_ca platform "$ROOT/organizations/fabric-ca/platform/ca-cert.pem"
wait_for_ca issuers "$ROOT/organizations/fabric-ca/issuers/tls-cert.pem"
wait_for_ca orderer "$ROOT/organizations/fabric-ca/orderer/tls-cert.pem"

create_platform
create_issuers
create_orderer

cat \
  "$ROOT/organizations/peerOrganizations/platform.certnet.local/peers/peer0.platform.certnet.local/tls/ca.crt" \
  "$ROOT/organizations/peerOrganizations/issuers.certnet.local/peers/peer0.issuers.certnet.local/tls/ca.crt" \
  "$ROOT/organizations/ordererOrganizations/certnet.local/orderers/orderer.certnet.local/tls/ca.crt" \
  > "$ROOT/organizations/gateway-tls-ca.pem"

echo "Enrollment complete"
