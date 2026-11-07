import { describe, expect, it } from "vitest";
import { assertPasswordPolicy, canonicalCertificateHash, newCertificateId, sha256, stableStringify } from "../src/crypto";

describe("fingerprints and identifiers", () => {
  it("hashes exact bytes and ignores object key order", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(stableStringify({ b: 1, a: "x" })).toBe(stableStringify({ a: "x", b: 1 }));
  });

  it("builds a stable canonical hash and a Crockford certificate id", () => {
    const fields = {
      type: "SEE",
      fullName: "Sample Holder (Praman demo)",
      dateOfBirth: "2008-04-12",
      symbolOrRegNo: "20820001",
      programName: "Secondary Education Examination",
      academicYearBs: "2082",
      academicYearAd: 2025,
      gpaOrDivision: "3.45",
      streamOrFaculty: "",
      campusOrSchool: "Sample Campus (Praman demo)",
      issueDate: "2025-07-01",
      institutionRegistration: "DEMO-SEE-2082",
    };
    expect(canonicalCertificateHash(fields)).toBe(canonicalCertificateHash({ ...fields, fullName: "  Sample Holder (Praman demo)  " }));
    expect(canonicalCertificateHash(fields)).not.toBe(canonicalCertificateHash({ ...fields, gpaOrDivision: "3.46" }));
    expect(newCertificateId("SEE", "2082")).toMatch(/^NPL-SEE-2082-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(newCertificateId("PLUS_TWO", "2082")).toMatch(/^NPL-P2-2082-/);
    expect(newCertificateId("UNIVERSITY", "2082")).toMatch(/^NPL-UNI-2082-/);
  });

  it("rejects weak passwords", () => {
    expect(() => assertPasswordPolicy("short1", "a@b.c")).toThrow(/12/);
    expect(() => assertPasswordPolicy("alllettersno", "a@b.c")).toThrow(/letter/);
    expect(() => assertPasswordPolicy("person1@example.com", "person1@example.com")).toThrow(/email/);
  });
});
