import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { assertSafePdf, buildCertificatePdf } from "../src/pdf";

describe("PDF upload checks", () => {
  it("rejects empty, non-PDF, oversized, and active content", () => {
    expect(() => assertSafePdf(Buffer.alloc(0), 1000)).toThrow(ApiError);
    expect(() => assertSafePdf(Buffer.from("not a pdf"), 1000)).toThrow(/PDF/);
    expect(() => assertSafePdf(Buffer.from("%PDF-1.7\nhello"), 4)).toThrow(/limit/);
    expect(() => assertSafePdf(Buffer.from("%PDF-1.7\n/JavaScript (alert)"), 1000)).toThrow(/active/);
    expect(() => assertSafePdf(Buffer.from("%PDF-1.7\n/OpenAction 1 0 R"), 1000)).toThrow(/active/);
  });

  it("accepts a generated prototype certificate", async () => {
    const pdf = await buildCertificatePdf({
      certificateId: "NPL-SEE-2082-0123456789",
      verificationUrl: "http://localhost:8080/verify/NPL-SEE-2082-0123456789",
      institutionName: "Sample SEE Board (Praman demo)",
      certificateTypeLabel: "Secondary Education Examination (SEE)",
      holderName: "Sample Holder (Praman demo)",
      symbolOrRegNo: "20820001",
      programName: "SEE",
      academicYearBs: "2082",
      gpaOrDivision: "3.20",
      campusOrSchool: "Sample Campus (Praman demo)",
      issueDate: "2025-07-01",
    });
    expect(() => assertSafePdf(pdf, 2_000_000)).not.toThrow();
    const opened = await PDFDocument.load(pdf);
    expect(opened.getPageCount()).toBe(1);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
