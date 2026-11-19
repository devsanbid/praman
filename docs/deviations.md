# Deviations from the proposal

These are deliberate prototype limits. They are not silent replacements of the blockchain.

- Chaincode is Go. Fabric's best-supported contract API for this network is Go. The API and web application remain TypeScript.
- Chaincode runs as two external CCaaS processes instead of a Docker-in-Docker build on each peer. Both peers still endorse.
- There is one Raft orderer. The proposal's permissioned network is present; it is not crash-tolerant.
- Institutions are IssuerMSP identities enrolled from one issuer CA. They are not each a separate peer organization. Separate organizations per school would not fit a student demo, and the chaincode still enforces the caller identity.
- Verification hashes the PDF bytes. A canonical hash of the form fields is stored off-chain only. A field-only hash would miss a change that is visible in the file but normalised away.
- The on-chain timestamp is the Fabric transaction time. The academic issue date stays in PostgreSQL.
- LevelDB is the peer state database. CouchDB was not required for key lookups.
- Batch timeout is one second so a demo does not wait on the default two-second batch.
- Generated PDFs are labelled “PRAMAN PROTOTYPE” and state that they are not Government of Nepal certificates. Sign-in cards use fictional names such as Himalaya University and Rahul Shrestha. The issue form fills the same kind of ordinary names.
- A suspended issuer cannot write, but previously issued fingerprints remain valid. The verification payload reports issuer standing separately.
- Development key directories are mode-relaxed so the API container can read material created as root. Application issuer keys stay mode `0600`.
- The issuer CA registrar key is mounted into the API container. See the threat model.
- Cookies are `Secure` only when `PUBLIC_APP_URL` is HTTPS. The local demo is HTTP on localhost.
- Public self-registration cannot create an institution administrator. That follows the approval workflow rather than an open issuer signup.
- The home page shows prototype accounts and the shared password `PramanDemo2082`, and one click signs that role in. The API still checks the role on every protected request. This is for the assignment demonstration, not a deployment.
