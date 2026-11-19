# Ethics and RQ3

The proposal asks what a certificate ledger should not claim. Praman follows these rules in the product, not only in this note.

- A student or applicant is told, before issuance, that a fingerprint will be recorded. The API rejects the issue call without that confirmation.
- The ledger is not a store of names, dates of birth, grades, or scans. Those remain in the operator's database, which is a normal personal-data store and needs access control, retention, and a way to correct a mistaken off-chain row without rewriting history.
- Revocation does not delete the fact of issuance. That is the point of an append-only log, and it means a revoked certificate remains discoverable by its identifier.
- Public QR pages show status, issuer, programme, and year. They do not show the holder's name or results. Sharing a link is not the same as publishing a mark sheet.
- Verification tells the reader whether a file matches a record. It does not identify the person who uploaded it. Institutions and employers still have to check identity themselves.
- The prototype must not be described as an official Nepali credential. The landing page, the generated PDF, and this documentation say that it is a student research system.
- Sign-in cards and the issue form use fictional people and institutions, such as Rahul Shrestha and Himalaya University. These are not real student records or a real university. Do not load real students' certificates into this network.
- An employer who wants a portable proof can misuse a public identifier to probe whether someone holds a certificate. Status lookups are rate-limited. They still leak existence for a known identifier. The identifier should be treated as a secret the holder chooses to share.
