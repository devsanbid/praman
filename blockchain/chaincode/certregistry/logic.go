package main

import (
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	statusValid     = "VALID"
	statusRevoked   = "REVOKED"
	issuerActive    = "ACTIVE"
	issuerSuspended = "SUSPENDED"

	resultValid         = "VALID"
	resultTampered      = "TAMPERED"
	resultRevoked       = "REVOKED"
	resultNotFound      = "NOT_FOUND"
	resultInvalidIssuer = "INVALID_ISSUER"

	maxReasonLen = 200
)

var (
	certificateIDPattern = regexp.MustCompile(`^NPL-(SEE|P2|UNI)-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{10}$`)
	sha256Pattern        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	uuidPattern          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	enrollmentPattern    = regexp.MustCompile(`^[a-zA-Z0-9._-]{3,64}$`)
)

// CertRecord is the only certificate data stored on the ledger.
// Personal details and the PDF stay off-chain.
type CertRecord struct {
	CertificateID    string `json:"certificateId"`
	Sha256           string `json:"sha256"`
	IssuerID         string `json:"issuerId"`
	Status           string `json:"status"`
	IssuedAt         string `json:"issuedAt"`
	RevokedAt        string `json:"revokedAt,omitempty" metadata:",optional"`
	RevocationReason string `json:"revocationReason,omitempty" metadata:",optional"`
}

// IssuerRecord is the permissioned issuer registration. It contains no student data.
type IssuerRecord struct {
	IssuerID       string `json:"issuerId"`
	InstitutionRef string `json:"institutionRef"`
	EnrollmentID   string `json:"enrollmentId"`
	Status         string `json:"status"`
	RegisteredAt   string `json:"registeredAt"`
}

// VerifyOutcome is the chaincode's integrity decision.
type VerifyOutcome struct {
	Result            string `json:"result"`
	CertificateID     string `json:"certificateId,omitempty" metadata:",optional"`
	Sha256            string `json:"sha256,omitempty" metadata:",optional"`
	IssuerID          string `json:"issuerId,omitempty" metadata:",optional"`
	IssuerStatus      string `json:"issuerStatus,omitempty" metadata:",optional"`
	CertificateStatus string `json:"certificateStatus,omitempty" metadata:",optional"`
	IssuedAt          string `json:"issuedAt,omitempty" metadata:",optional"`
	RevokedAt         string `json:"revokedAt,omitempty" metadata:",optional"`
	RevocationReason  string `json:"revocationReason,omitempty" metadata:",optional"`
}

type codedError struct {
	Code string
	Msg  string
}

func (e *codedError) Error() string {
	return e.Code + ": " + e.Msg
}

func invalid(msg string) error {
	return &codedError{Code: "INVALID_ARGUMENT", Msg: msg}
}

func forbidden(msg string) error {
	return &codedError{Code: "FORBIDDEN", Msg: msg}
}

func alreadyExists(msg string) error {
	return &codedError{Code: "ALREADY_EXISTS", Msg: msg}
}

func notFound(msg string) error {
	return &codedError{Code: "NOT_FOUND", Msg: msg}
}

func validateCertificateID(id string) error {
	if !certificateIDPattern.MatchString(id) {
		return invalid("certificateId must look like NPL-SEE-2082-XXXXXXXXXX")
	}
	return nil
}

func validateSHA256(sum string) error {
	if !sha256Pattern.MatchString(sum) {
		return invalid("sha256 must be 64 lowercase hex characters")
	}
	return nil
}

func validateIssuerID(id string) error {
	if len(id) < 8 || len(id) > 80 || strings.ContainsAny(id, " \t\r\n") {
		return invalid("issuerId is not valid")
	}
	return nil
}

func validateInstitutionRef(ref string) error {
	if !uuidPattern.MatchString(ref) {
		return invalid("institutionRef must be a uuid")
	}
	return nil
}

func validateEnrollmentID(id string) error {
	if !enrollmentPattern.MatchString(id) {
		return invalid("enrollmentId is not valid")
	}
	return nil
}

func validateReason(reason string) error {
	trimmed := strings.TrimSpace(reason)
	if len(trimmed) < 3 || len(trimmed) > maxReasonLen {
		return invalid("revocation reason must be between 3 and 200 characters")
	}
	for _, r := range trimmed {
		if r == '\n' || r == '\r' || unicode.IsControl(r) {
			return invalid("revocation reason contains control characters")
		}
	}
	return nil
}

// decideVerification applies the research rules in a fixed order.
// A different file is TAMPERED even when the ledger row was later revoked.
// Revocation wins only when the submitted fingerprint is the registered one.
// A suspended issuer does not rewrite history: existing fingerprints still verify,
// and the caller reports issuerStatus separately.
func decideVerification(record *CertRecord, issuer *IssuerRecord, submittedHash string) VerifyOutcome {
	if record == nil {
		return VerifyOutcome{Result: resultNotFound}
	}
	outcome := VerifyOutcome{
		Result:            resultValid,
		CertificateID:     record.CertificateID,
		Sha256:            record.Sha256,
		IssuerID:          record.IssuerID,
		CertificateStatus: record.Status,
		IssuedAt:          record.IssuedAt,
		RevokedAt:         record.RevokedAt,
		RevocationReason:  record.RevocationReason,
	}
	if issuer != nil {
		outcome.IssuerStatus = issuer.Status
	}
	if submittedHash != "" && submittedHash != record.Sha256 {
		outcome.Result = resultTampered
		return outcome
	}
	if issuer == nil {
		outcome.Result = resultInvalidIssuer
		return outcome
	}
	if record.Status == statusRevoked {
		outcome.Result = resultRevoked
		return outcome
	}
	if record.Status != statusValid {
		outcome.Result = resultInvalidIssuer
		return outcome
	}
	outcome.Result = resultValid
	return outcome
}

func txTime(seconds int64, nanos int32) string {
	return time.Unix(seconds, int64(nanos)).UTC().Format(time.RFC3339)
}

func certKey(id string) string {
	return "cert|" + id
}

func issuerKey(id string) string {
	return "issuer|" + id
}

func hashKey(sum string) string {
	return "hash|" + sum
}

func assertTransitionToRevoked(record CertRecord) error {
	if record.Status == statusRevoked {
		return alreadyExists("certificate is already revoked")
	}
	if record.Status != statusValid {
		return forbidden("only a valid certificate can be revoked")
	}
	return nil
}
