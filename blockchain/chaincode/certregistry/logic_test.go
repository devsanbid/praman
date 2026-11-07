package main

import "testing"

func TestValidateCertificateID(t *testing.T) {
	valid := []string{
		"NPL-SEE-2082-7K3H9Q2M4P",
		"NPL-P2-2081-0123456789",
		"NPL-UNI-2024-ABCDEFGHJK",
	}
	for _, id := range valid {
		if err := validateCertificateID(id); err != nil {
			t.Fatalf("expected %s to be valid: %v", id, err)
		}
	}
	invalidIDs := []string{
		"",
		"NPL-SEE-82-7K3H9Q2M4P",
		"NPL-SEE-2082-7K3H9Q2M4I", // I is not in the Crockford alphabet
		"NPL-SEE-2082-7k3h9q2m4p",
		"SEE-2082-7K3H9Q2M4P",
		"NPL-BACHELOR-2082-7K3H9Q2M4P",
	}
	for _, id := range invalidIDs {
		if err := validateCertificateID(id); err == nil {
			t.Fatalf("expected %s to be rejected", id)
		}
	}
}

func TestValidateSHA256(t *testing.T) {
	if err := validateSHA256("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []string{"", "ABCD", "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", "gg"} {
		if err := validateSHA256(sample); err == nil {
			t.Fatalf("expected %s to be rejected", sample)
		}
	}
}

func TestValidateReason(t *testing.T) {
	if err := validateReason("Issued in error"); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []string{"no", "  x ", "bad\nreason", string(make([]byte, 201))} {
		if err := validateReason(sample); err == nil {
			t.Fatalf("expected reason %q to be rejected", sample)
		}
	}
}

func TestDecideVerification(t *testing.T) {
	const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	record := &CertRecord{
		CertificateID: "NPL-SEE-2082-7K3H9Q2M4P",
		Sha256:        hash,
		IssuerID:      "issuer-1",
		Status:        statusValid,
		IssuedAt:      "2026-07-01T00:00:00Z",
	}
	issuer := &IssuerRecord{IssuerID: "issuer-1", Status: issuerActive}

	cases := []struct {
		name   string
		record *CertRecord
		issuer *IssuerRecord
		hash   string
		want   string
	}{
		{"valid", record, issuer, hash, resultValid},
		{"tampered", record, issuer, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", resultTampered},
		{"tampered even if revoked", &CertRecord{CertificateID: record.CertificateID, Sha256: hash, IssuerID: "issuer-1", Status: statusRevoked}, issuer, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", resultTampered},
		{"revoked matching hash", &CertRecord{CertificateID: record.CertificateID, Sha256: hash, IssuerID: "issuer-1", Status: statusRevoked, RevocationReason: "Issued in error"}, issuer, hash, resultRevoked},
		{"missing record", nil, issuer, hash, resultNotFound},
		{"missing issuer", record, nil, hash, resultInvalidIssuer},
		{"suspended issuer still authentic document", record, &IssuerRecord{IssuerID: "issuer-1", Status: issuerSuspended}, hash, resultValid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideVerification(tc.record, tc.issuer, tc.hash)
			if got.Result != tc.want {
				t.Fatalf("got %s, want %s", got.Result, tc.want)
			}
		})
	}
}

func TestRevokeTransition(t *testing.T) {
	if err := assertTransitionToRevoked(CertRecord{Status: statusValid}); err != nil {
		t.Fatal(err)
	}
	if err := assertTransitionToRevoked(CertRecord{Status: statusRevoked}); err == nil {
		t.Fatal("expected already revoked")
	}
}
