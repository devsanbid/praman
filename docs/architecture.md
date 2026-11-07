# Architecture

```text
Browser (React)
    |  same-origin /api
Nginx or Vite
    |
Express API  ---- PostgreSQL (profiles, PDFs metadata, audit)
    |        \--- disk (PDF bytes, issuer wallets)
    |
Fabric Gateway
    |
peer0.platform + peer0.issuers  -->  chaincode certregistry (two CCaaS processes)
    |
one etcdraft orderer, channel certchannel
```

The React application is a set of role pages over `/api/v1`. Nginx in Docker, or the Vite dev server, proxies that prefix to the API so the session cookie stays on one origin.

PostgreSQL holds users, institutions, students, certificate metadata, verification logs, the audit hash chain, and blockchain transaction references. Prisma migrations create the tables. The PDF bytes live under `UPLOAD_DIR` as `{certificateId}.pdf`.

The API submits ledger writes with the institution's enrolled IssuerMSP identity. Reads use a platform verifier identity that cannot pass the issuer or admin checks inside the chaincode. Approval uses the platform admin identity, which must carry OU `admin`.

Chaincode functions: `RegisterIssuer`, `SuspendIssuer`, `ReactivateIssuer`, `GetIssuer`, `IssueCertificate`, `RevokeCertificate`, `GetCertificate`, `GetCertificateByHash`, `VerifyCertificate`, `GetCertificateHistory`, and `Ping`.

Endorsement requires both peer organizations. Personal fields never enter the chaincode arguments. The verification fingerprint is the SHA-256 of the exact PDF bytes. A second canonical hash of the academic fields is stored only in PostgreSQL so a future comparison can say which fact changed; the public decision uses the file hash.

## Request path for issuance

1. Validate the form, the consent flag, and the PDF.
2. Build or accept the PDF. Generated PDFs embed the verification URL and a prototype banner.
3. Hash the bytes, write the file, and insert a `PENDING_CHAIN` row.
4. Submit `IssueCertificate` and wait for commit status.
5. Mark the row `VALID` and store the transaction id only after that status is successful.
6. If the client loses the response, `GetCertificate` is used to reconcile. An administrator can call the same reconciliation explicitly.

## Public verification

`GET /api/v1/verify/{id}` reads ledger status and returns institution, programme, year, and status. It omits name, date of birth, symbol number, and grades.

`POST /api/v1/verify` hashes the uploaded PDF and calls `VerifyCertificate`. Holder fields are added only when the caller is signed in and the fingerprint matches.
