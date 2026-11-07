# Praman

Praman is a final-year prototype of a permissioned academic-certificate registry for Nepal. Approved institutions record a SHA-256 fingerprint of a SEE, +2, or university certificate on Hyperledger Fabric. Employers and universities compare a PDF with that fingerprint. The ledger does not hold the student record.

This is not a system of the Government of Nepal, NEB, or any university. A matching fingerprint does not prove who is holding the document.

## What you get

- React, TypeScript, and Tailwind interface for administrators, institutions, students, and verifiers
- Node.js and Express API with Argon2id sessions, CSRF, and role checks
- PostgreSQL and Prisma
- Hyperledger Fabric 2.5 network, Fabric CA, and Go chaincode `certregistry`
- Issuance that succeeds only after the Fabric commit
- Upload verification, QR status links, revocation, and an append-only audit log
- OpenAPI at `/api/docs` when the API is running

Design notes are in `docs/`: requirements, architecture, blockchain membership, threat model, deviations, and ethics.

## Prerequisites

Docker with Compose, Node.js 22, and Go 1.22 or newer. The Fabric images are pulled by the scripts. Ports used: 5432, 4000, 7050, 7051, 7053, 7054, 8054, 8080, 9051, 9054.

## Run the full stack

Docker must be running. Go and OpenSSL are used while the blockchain is prepared.

```bash
bash install.sh
```

That creates `.env` on the first run, starts the Fabric network, then starts PostgreSQL, the API, and the website. Do not commit `.env` or `blockchain/organizations/`.

Stop every Praman container, and keep the database and the ledger:

```bash
bash stop.sh
```

`bash scripts/fabric-down.sh` is the full reset. It deletes the Fabric identities as well. It does not drop PostgreSQL. `docker compose --env-file .env down` stops only the website, API, and database.

Open http://localhost:8080. The home page lists prototype accounts. Click one to sign in. Every demo account uses the password `PramanDemo2082`. The administrator email is `admin@praman.local`. The university is `university@praman.demo` and the student is `student@praman.demo`. A sample university certificate is already linked to the student when the ledger is up. Swagger is at http://localhost:8080/api/docs.

The API replaces the administrator password with `PramanDemo2082` on startup so the card on the home page matches. `ADMIN_PASSWORD` in `.env` is used only when that account does not exist yet.

Optional demo accounts, still pending approval:

```bash
# set DEMO_PASSWORD in .env first (12 or more characters, with a letter and a number)
docker compose --env-file .env exec backend npm run seed:demo
```

Demo names are “Sample … (Praman demo)”. Approving an institution in the admin UI enrols its Fabric identity. If Fabric is down, approval fails and nothing is marked approved.

## Run the API on the host

Add the Fabric DNS names to `/etc/hosts`:

```text
127.0.0.1 peer0.platform.certnet.local peer0.issuers.certnet.local orderer.certnet.local ca.issuers.certnet.local ca.platform.certnet.local
```

```bash
docker compose --env-file .env up -d postgres
bash scripts/fabric-up.sh
bash scripts/with-host-env.sh npm --prefix backend run dev
npm --prefix frontend install
npm --prefix frontend run dev
```

`with-host-env.sh` points the API at the certificates and wallets on the host. It does not print secrets.

## Tests

```bash
cd blockchain/chaincode/certregistry && go test ./...
cd backend && npx vitest run
cd frontend && npm test
```

Backend API tests need Postgres and the migrated database from `.env`.

`scripts/evaluate.mjs` issues a real certificate, checks a matching file, a modified file, an unknown id, and a revocation, then records observed latencies:

```bash
bash scripts/with-host-env.sh node scripts/evaluate.mjs
```

The API must already be running and the ledger must answer `/api/v1/health`. If either is down, the script writes `reports/verification-latency.json` with `status: failed` and does not invent timings. The proposal's median target is under five seconds.

## Reset the ledger

```bash
bash stop.sh
bash scripts/fabric-down.sh
```

`fabric-down.sh` removes the Fabric containers and the gitignored organization material, including files owned by the container user. It does not drop PostgreSQL. Institution rows that point at deleted issuer keys cannot issue until `bash install.sh` enrols them again.
