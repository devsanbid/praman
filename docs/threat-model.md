# Threat model

Praman assumes an honest majority of the two peer organizations and a working orderer on a network the operator controls. It does not assume that a PDF, a QR code, or a screenshot is authentic by appearance.

## Assets

- Issuer private keys and CA registrar key.
- Session secrets and password hashes.
- Certificate PDFs and student attributes.
- The audit log and the ledger history.

## Actors

- A holder or employer with a file or a verification URL.
- An institution staff member who may be unauthorised for issue or revoke.
- A platform administrator.
- Someone who can upload a file to the public verify endpoint.
- Someone who can read a stolen database backup but not the ledger keys, or the reverse.

## Decisions

| Threat | Control |
| --- | --- |
| Guessed passwords | Argon2id, length and character policy, lockout after five failures |
| Stolen session cookie used from another site | SameSite=Lax, CSRF header on cookie-authenticated mutations, HttpOnly session cookie |
| Forged issuer | Chaincode checks MSP, attributes, common name, and issuer status |
| Altered PDF | SHA-256 of the exact bytes; tamper result precedes revocation |
| Replayed issuance | Certificate id and fingerprint are unique on the ledger; optional idempotency key in PostgreSQL |
| Malicious PDF | Size cap, `%PDF-` prefix, rejection of JavaScript, Launch, embedded files, and OpenAction |
| SQL injection | Parameterised Prisma queries |
| XSS | React escaping, JSON APIs, helmet headers |
| Audit tampering | Hash chain over canonical JSON, transaction advisory lock, trigger rejecting UPDATE and DELETE |
| Public exposure of a student | QR and status pages omit name, date of birth, symbol, and grades. Holder fields require a signed-in caller and a matching file |
| Ledger used as a population register | Personal data is not written to chaincode arguments |
| Fake success when Fabric is down | Approval, issue, and revoke return an error until commit status is successful |

## Residual risk

The issuer CA registrar key is on the API host so the prototype can enrol institutions without a separate operator console. A host compromise can enrol issuers. Production would split that duty.

One orderer can halt the network. Suspension does not invalidate old fingerprints; a verifier must read `issuerStatus`.

A matching hash does not bind the file to the person standing at a counter. The UI says so. The system also cannot detect a real certificate that was never submitted by the institution.

Audit metadata is minimised, but a certificate id is an identifier. IP addresses are stored as a truncated hash, not in the clear.
