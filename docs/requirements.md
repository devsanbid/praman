# Requirements

Source: `assignment.pdf`, “Fake Academic Certificate Verification Using Blockchain Technology in Nepal”. Praman is a final-year prototype of that proposal. It is not a national deployment and it does not speak for NEB, a university, or the Government of Nepal.

## Research questions

- RQ1. Can a permissioned ledger detect a changed certificate file, and can verification complete with a median latency under five seconds?
- RQ2. Can the ledger store only a fingerprint, issuer, status, and timestamps while the PDF and personal data stay off-chain?
- RQ3. What consent, privacy, and misuse limits should a system like this state in public?

## Roles

- Super administrator: approve or reject institutions, suspend issuers, read the audit log, manage users and the public notice, reconcile a database row with the ledger.
- Institution administrator and staff: issue and revoke only for their own approved institution. Staff permissions are explicit. New staff must change a temporary password.
- Student: view and download certificates linked by email or by a claim of certificate id, date of birth, and symbol number.
- Verifier: check a file or an identifier. A verifier cannot issue or revoke.

Public registration creates only students and verifiers. An institution cannot issue until an administrator approves it, which enrols a Fabric identity and commits `RegisterIssuer`.

## Certificate types

SEE, higher secondary (+2), and university. The identifier shape is `NPL-{SEE|P2|UNI}-{BS year}-{10 Crockford characters}`.

## Ledger record

On-chain: certificate id, SHA-256 of the PDF bytes, issuer id, status, issue timestamp, and revocation time and reason when revoked.

Off-chain: the PDF, name, date of birth, symbol number, programme, grades, and institution profile.

## Verification results

- VALID: the submitted bytes match the stored fingerprint, the issuer exists, and the certificate is not revoked.
- TAMPERED: the bytes do not match. This wins over a later revocation.
- REVOKED: the bytes match a certificate that was revoked.
- NOT_FOUND: no ledger record.
- INVALID_ISSUER: the issuer record is missing.
- ERROR: the check could not be completed.

A status lookup that does not upload a file must say that the file itself was not compared. A fingerprint match does not prove the presenter's legal identity.

## Issuance and revocation

Issuance is successful only after Fabric reports a successful commit. If the submit call fails, the API reads the ledger and marks the row valid only when the same fingerprint is present. Revocation is an additional write. History is kept. A suspended issuer cannot issue or revoke; certificates already recorded stay verifiable, and the issuer standing is reported separately.

## Non-functional

- Argon2id passwords, HTTP-only session cookies, CSRF on cookie-authenticated mutations, role checks on the server.
- Rate limits, security headers, upload size and PDF active-content checks.
- Append-only audit hash chain, plus a database trigger that rejects updates and deletes.
- Docker Compose for Postgres, the API, the web app, and the Fabric network.
- Automated tests and a measurement script that writes only observed timings.
