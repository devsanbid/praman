import { describe, expect, it } from "vitest";
import { resultPresentation } from "./results";

describe("resultPresentation", () => {
  it("does not treat a status lookup as a file match", () => {
    expect(resultPresentation("VALID", false).title).toBe("Ledger record is valid");
    expect(resultPresentation("VALID", true).title).toBe("Fingerprint matches");
  });

  it("keeps tamper, revoke, and missing records distinct", () => {
    expect(resultPresentation("TAMPERED", true).tone).toBe("bad");
    expect(resultPresentation("REVOKED", true).tone).toBe("warn");
    expect(resultPresentation("NOT_FOUND", true).title).toBe("No ledger record");
    expect(resultPresentation("ERROR", true).title).toBe("Verification incomplete");
  });
});
