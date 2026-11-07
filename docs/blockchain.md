# Blockchain network

Hyperledger Fabric 2.5.12 with Fabric CA 1.5.15. The network is permissioned and local.

## Membership

| Organization | MSP | Components |
| --- | --- | --- |
| Platform | PlatformMSP | CA :7054, peer0.platform.certnet.local:7051, admin and verifier clients |
| Issuers | IssuerMSP | CA :8054, peer0.issuers.certnet.local:9051, one peer admin |
| Orderer | OrdererMSP | CA :9054, one etcdraft orderer :7050, admin :7053 |

Channel: `certchannel`. Batch timeout: 1 second. Consenters: the single orderer. This Raft group is not crash-tolerant. A second orderer was not added because the prototype runs on one machine.

Institutions are not separate Fabric organizations. Each approved institution is an IssuerMSP client enrolled from `ca.issuers`, with certificate attributes `cert.role=issuer` and `cert.issuerId`, and a common name equal to the enrollment id. The API trusts `ca-cert.pem` beside the configured TLS leaf, because Node.js will not treat that leaf as a trust anchor. Registrar calls use the Fabric CA token format: the ECDSA signature covers `POST`, the request path, the body, and the registrar certificate, and the `S` value is reduced to the low half of the P-256 order. Institution enrollment keys are NIST P-256. The Fabric gateway signer does not accept RSA identities. The chaincode accepts an issue transaction only when all of those match an `ACTIVE` issuer record. Platform administration requires PlatformMSP and OU `admin`.

## Endorsement and chaincode

The lifecycle endorsement policy is `AND('PlatformMSP.peer','IssuerMSP.peer')`. Chaincode runs as an external service (CCaaS), one process per peer (`chaincode.platform` and `chaincode.issuers`), using the peer image's built-in `_lifecycle` external builder. TLS between peer and chaincode is disabled on the Docker network. Application gateway TLS trusts the platform peer, issuer peer, and orderer TLS CAs in one bundle.

World-state keys:

- `cert|{id}` certificate record
- `issuer|{id}` issuer record
- `hash|{sha256}` certificate id, so a fingerprint cannot be registered twice

`GetHistoryForKey` retains earlier writes after revocation. State is LevelDB on the peer, not CouchDB. Revocation fields and the extra verification fields are marked `metadata:",optional"` so the contract schema accepts a newly issued record that has no revocation timestamp.

## What the application waits for

`submitAsync` is followed by `getStatus()`. The API treats the call as a failure unless `successful` is true. Evaluation is used for verify, get, and history. Those reads are not new transactions.

## Identity files

`scripts/fabric-up.sh` enrols the network, creates the channel, installs and commits `certregistry`, and invokes `Ping`. Issuer keys created later are written to `WALLET_DIR/issuers/{id}/` with mode `0600`. Network material under `blockchain/organizations/` is gitignored. The script makes that tree readable by the API container because Docker creates it as root. That is a local-development choice, not a production key-control design.
