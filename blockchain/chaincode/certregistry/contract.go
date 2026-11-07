package main

import (
	"encoding/json"

	"github.com/hyperledger/fabric-chaincode-go/pkg/cid"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// CertificateContract is the permissioned academic-certificate registry.
// World state stores fingerprints and issuer registration only.
type CertificateContract struct {
	contractapi.Contract
}

const (
	platformMSP = "PlatformMSP"
	issuerMSP   = "IssuerMSP"
	roleIssuer  = "issuer"
)

func (c *CertificateContract) Ping(ctx contractapi.TransactionContextInterface) (string, error) {
	return "ok", nil
}

// RegisterIssuer records an institution identity. Only a PlatformMSP admin may call it.
func (c *CertificateContract) RegisterIssuer(
	ctx contractapi.TransactionContextInterface,
	issuerID string,
	institutionRef string,
	enrollmentID string,
) (*IssuerRecord, error) {
	if err := c.requirePlatformAdmin(ctx); err != nil {
		return nil, err
	}
	if err := validateIssuerID(issuerID); err != nil {
		return nil, err
	}
	if err := validateInstitutionRef(institutionRef); err != nil {
		return nil, err
	}
	if err := validateEnrollmentID(enrollmentID); err != nil {
		return nil, err
	}
	existing, err := c.readIssuer(ctx, issuerID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, alreadyExists("issuer is already registered")
	}
	stamp, err := c.now(ctx)
	if err != nil {
		return nil, err
	}
	record := IssuerRecord{
		IssuerID:       issuerID,
		InstitutionRef: institutionRef,
		EnrollmentID:   enrollmentID,
		Status:         issuerActive,
		RegisteredAt:   stamp,
	}
	if err := putJSON(ctx, issuerKey(issuerID), record); err != nil {
		return nil, err
	}
	return &record, nil
}

// SuspendIssuer stops an institution from issuing or revoking. It does not rewrite certificates.
func (c *CertificateContract) SuspendIssuer(ctx contractapi.TransactionContextInterface, issuerID string) (*IssuerRecord, error) {
	return c.setIssuerStatus(ctx, issuerID, issuerSuspended)
}

// ReactivateIssuer restores an institution's ability to issue and revoke.
func (c *CertificateContract) ReactivateIssuer(ctx contractapi.TransactionContextInterface, issuerID string) (*IssuerRecord, error) {
	return c.setIssuerStatus(ctx, issuerID, issuerActive)
}

func (c *CertificateContract) setIssuerStatus(ctx contractapi.TransactionContextInterface, issuerID, status string) (*IssuerRecord, error) {
	if err := c.requirePlatformAdmin(ctx); err != nil {
		return nil, err
	}
	if err := validateIssuerID(issuerID); err != nil {
		return nil, err
	}
	record, err := c.readIssuer(ctx, issuerID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, notFound("issuer not found")
	}
	record.Status = status
	if err := putJSON(ctx, issuerKey(issuerID), record); err != nil {
		return nil, err
	}
	return record, nil
}

// GetIssuer returns the on-chain issuer registration.
func (c *CertificateContract) GetIssuer(ctx contractapi.TransactionContextInterface, issuerID string) (*IssuerRecord, error) {
	if err := validateIssuerID(issuerID); err != nil {
		return nil, err
	}
	record, err := c.readIssuer(ctx, issuerID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, notFound("issuer not found")
	}
	return record, nil
}

// IssueCertificate records a fingerprint. The caller must be the active issuer identity.
// issuerId is taken from the caller's certificate attribute, not from an argument.
func (c *CertificateContract) IssueCertificate(
	ctx contractapi.TransactionContextInterface,
	certificateID string,
	sha256hex string,
) (*CertRecord, error) {
	if err := validateCertificateID(certificateID); err != nil {
		return nil, err
	}
	if err := validateSHA256(sha256hex); err != nil {
		return nil, err
	}
	issuer, err := c.requireActiveIssuer(ctx)
	if err != nil {
		return nil, err
	}
	existing, err := c.readCert(ctx, certificateID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, alreadyExists("certificate id already exists")
	}
	hashOwner, err := ctx.GetStub().GetState(hashKey(sha256hex))
	if err != nil {
		return nil, err
	}
	if hashOwner != nil {
		return nil, alreadyExists("fingerprint is already registered")
	}
	stamp, err := c.now(ctx)
	if err != nil {
		return nil, err
	}
	record := CertRecord{
		CertificateID: certificateID,
		Sha256:        sha256hex,
		IssuerID:      issuer.IssuerID,
		Status:        statusValid,
		IssuedAt:      stamp,
	}
	if err := putJSON(ctx, certKey(certificateID), record); err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(hashKey(sha256hex), []byte(certificateID)); err != nil {
		return nil, err
	}
	return &record, nil
}

// RevokeCertificate appends a revocation. The original issuance remains in history.
// The active issuer identity or a platform admin may revoke.
func (c *CertificateContract) RevokeCertificate(
	ctx contractapi.TransactionContextInterface,
	certificateID string,
	reason string,
) (*CertRecord, error) {
	if err := validateCertificateID(certificateID); err != nil {
		return nil, err
	}
	if err := validateReason(reason); err != nil {
		return nil, err
	}
	record, err := c.readCert(ctx, certificateID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, notFound("certificate not found")
	}
	if err := assertTransitionToRevoked(*record); err != nil {
		return nil, err
	}
	if err := c.requireRevokeAuthority(ctx, record.IssuerID); err != nil {
		return nil, err
	}
	stamp, err := c.now(ctx)
	if err != nil {
		return nil, err
	}
	record.Status = statusRevoked
	record.RevokedAt = stamp
	record.RevocationReason = reason
	if err := putJSON(ctx, certKey(certificateID), record); err != nil {
		return nil, err
	}
	return record, nil
}

// GetCertificate returns the current ledger record. History is not erased.
func (c *CertificateContract) GetCertificate(ctx contractapi.TransactionContextInterface, certificateID string) (*CertRecord, error) {
	if err := validateCertificateID(certificateID); err != nil {
		return nil, err
	}
	record, err := c.readCert(ctx, certificateID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, notFound("certificate not found")
	}
	return record, nil
}

// GetCertificateByHash resolves a fingerprint to the current record.
func (c *CertificateContract) GetCertificateByHash(ctx contractapi.TransactionContextInterface, sha256hex string) (*CertRecord, error) {
	if err := validateSHA256(sha256hex); err != nil {
		return nil, err
	}
	raw, err := ctx.GetStub().GetState(hashKey(sha256hex))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, notFound("fingerprint not found")
	}
	return c.GetCertificate(ctx, string(raw))
}

// VerifyCertificate compares a submitted fingerprint with the ledger and checks status.
// An empty sha256 performs a status lookup only; the result is then VALID, REVOKED,
// INVALID_ISSUER, or NOT_FOUND, and the caller must not treat that as a document check.
func (c *CertificateContract) VerifyCertificate(
	ctx contractapi.TransactionContextInterface,
	certificateID string,
	sha256hex string,
) (*VerifyOutcome, error) {
	if certificateID == "" && sha256hex != "" {
		if err := validateSHA256(sha256hex); err != nil {
			return nil, err
		}
		raw, err := ctx.GetStub().GetState(hashKey(sha256hex))
		if err != nil {
			return nil, err
		}
		if raw == nil {
			return &VerifyOutcome{Result: resultNotFound}, nil
		}
		certificateID = string(raw)
	}
	if err := validateCertificateID(certificateID); err != nil {
		return nil, err
	}
	if sha256hex != "" {
		if err := validateSHA256(sha256hex); err != nil {
			return nil, err
		}
	}
	record, err := c.readCert(ctx, certificateID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return &VerifyOutcome{Result: resultNotFound, CertificateID: certificateID}, nil
	}
	issuer, err := c.readIssuer(ctx, record.IssuerID)
	if err != nil {
		return nil, err
	}
	outcome := decideVerification(record, issuer, sha256hex)
	return &outcome, nil
}

// HistoryEntry is one immutable write of a certificate key.
type HistoryEntry struct {
	TxID      string      `json:"txId"`
	Timestamp string      `json:"timestamp"`
	IsDelete  bool        `json:"isDelete"`
	Record    *CertRecord `json:"record,omitempty"`
}

// GetCertificateHistory returns every write to the certificate key, oldest first.
func (c *CertificateContract) GetCertificateHistory(ctx contractapi.TransactionContextInterface, certificateID string) ([]HistoryEntry, error) {
	if err := validateCertificateID(certificateID); err != nil {
		return nil, err
	}
	iter, err := ctx.GetStub().GetHistoryForKey(certKey(certificateID))
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	entries := make([]HistoryEntry, 0)
	for iter.HasNext() {
		mod, err := iter.Next()
		if err != nil {
			return nil, err
		}
		entry := HistoryEntry{
			TxID:     mod.TxId,
			IsDelete: mod.IsDelete,
		}
		if mod.Timestamp != nil {
			entry.Timestamp = txTime(mod.Timestamp.Seconds, mod.Timestamp.Nanos)
		}
		if len(mod.Value) > 0 {
			var record CertRecord
			if err := json.Unmarshal(mod.Value, &record); err != nil {
				return nil, err
			}
			entry.Record = &record
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (c *CertificateContract) requirePlatformAdmin(ctx contractapi.TransactionContextInterface) error {
	stub := ctx.GetStub()
	mspID, err := cid.GetMSPID(stub)
	if err != nil {
		return err
	}
	if mspID != platformMSP {
		return forbidden("platform admin identity required")
	}
	cert, err := cid.GetX509Certificate(stub)
	if err != nil {
		return err
	}
	for _, ou := range cert.Subject.OrganizationalUnit {
		if ou == "admin" {
			return nil
		}
	}
	return forbidden("platform admin identity required")
}

func (c *CertificateContract) requireActiveIssuer(ctx contractapi.TransactionContextInterface) (*IssuerRecord, error) {
	stub := ctx.GetStub()
	mspID, err := cid.GetMSPID(stub)
	if err != nil {
		return nil, err
	}
	if mspID != issuerMSP {
		return nil, forbidden("issuer identity required")
	}
	role, found, err := cid.GetAttributeValue(stub, "cert.role")
	if err != nil {
		return nil, err
	}
	if !found || role != roleIssuer {
		return nil, forbidden("issuer attribute required")
	}
	issuerID, found, err := cid.GetAttributeValue(stub, "cert.issuerId")
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, forbidden("issuer id attribute required")
	}
	record, err := c.readIssuer(ctx, issuerID)
	if err != nil {
		return nil, err
	}
	if record == nil || record.Status != issuerActive {
		return nil, forbidden("issuer is not active")
	}
	cert, err := cid.GetX509Certificate(stub)
	if err != nil {
		return nil, err
	}
	if cert.Subject.CommonName != record.EnrollmentID {
		return nil, forbidden("enrollment id does not match the registered issuer")
	}
	return record, nil
}

func (c *CertificateContract) requireRevokeAuthority(ctx contractapi.TransactionContextInterface, issuerID string) error {
	if err := c.requirePlatformAdmin(ctx); err == nil {
		return nil
	}
	issuer, err := c.requireActiveIssuer(ctx)
	if err != nil {
		return forbidden("only the issuing institution or a platform admin can revoke this certificate")
	}
	if issuer.IssuerID != issuerID {
		return forbidden("only the issuing institution or a platform admin can revoke this certificate")
	}
	return nil
}

func (c *CertificateContract) readCert(ctx contractapi.TransactionContextInterface, id string) (*CertRecord, error) {
	raw, err := ctx.GetStub().GetState(certKey(id))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	var record CertRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

func (c *CertificateContract) readIssuer(ctx contractapi.TransactionContextInterface, id string) (*IssuerRecord, error) {
	raw, err := ctx.GetStub().GetState(issuerKey(id))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	var record IssuerRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

func (c *CertificateContract) now(ctx contractapi.TransactionContextInterface) (string, error) {
	stamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", err
	}
	return txTime(stamp.Seconds, stamp.Nanos), nil
}

func putJSON(ctx contractapi.TransactionContextInterface, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, raw)
}
