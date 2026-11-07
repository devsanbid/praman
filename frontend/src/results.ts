export type VerificationResult = "VALID" | "TAMPERED" | "REVOKED" | "NOT_FOUND" | "INVALID_ISSUER" | "ERROR";

export type ResultTone = "good" | "bad" | "warn" | "neutral";

export function resultPresentation(result: VerificationResult, documentChecked: boolean): { title: string; tone: ResultTone } {
  if (!documentChecked && result === "VALID") {
    return { title: "Ledger record is valid", tone: "neutral" };
  }
  if (!documentChecked && result === "REVOKED") {
    return { title: "Ledger record is revoked", tone: "warn" };
  }
  switch (result) {
    case "VALID":
      return { title: "Fingerprint matches", tone: "good" };
    case "TAMPERED":
      return { title: "File does not match", tone: "bad" };
    case "REVOKED":
      return { title: "Certificate revoked", tone: "warn" };
    case "NOT_FOUND":
      return { title: "No ledger record", tone: "bad" };
    case "INVALID_ISSUER":
      return { title: "Issuer not recognised", tone: "bad" };
    default:
      return { title: "Verification incomplete", tone: "neutral" };
  }
}
