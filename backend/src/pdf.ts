import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { ApiError } from "./errors";

const ACTIVE_CONTENT = /\/JavaScript|\/JS[\s/(<]|\/Launch|\/EmbeddedFile|\/OpenAction/;

export function assertSafePdf(buffer: Buffer, maxBytes: number): void {
  if (buffer.length === 0) throw new ApiError(400, "INVALID_FILE", "The uploaded file is empty");
  if (buffer.length > maxBytes) throw new ApiError(413, "FILE_TOO_LARGE", "The PDF exceeds the upload limit");
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new ApiError(400, "INVALID_FILE", "Only PDF documents can be fingerprinted");
  }
  const latin = buffer.toString("latin1");
  if (ACTIVE_CONTENT.test(latin)) {
    throw new ApiError(400, "INVALID_FILE", "The PDF contains active content and was rejected");
  }
}

export type GeneratedCertificate = {
  certificateId: string;
  verificationUrl: string;
  institutionName: string;
  certificateTypeLabel: string;
  holderName: string;
  symbolOrRegNo: string;
  programName: string;
  academicYearBs: string;
  gpaOrDivision: string;
  campusOrSchool: string;
  issueDate: string;
};

export async function buildCertificatePdf(input: GeneratedCertificate): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);

  page.drawRectangle({ x: 28, y: 28, width: 539, height: 786, borderColor: rgb(0.08, 0.24, 0.24), borderWidth: 1.5 });
  page.drawRectangle({ x: 36, y: 36, width: 523, height: 770, borderColor: rgb(0.72, 0.55, 0.22), borderWidth: 0.6 });

  page.drawText("PRAMAN PROTOTYPE", { x: 70, y: 760, size: 11, font: sans, color: rgb(0.45, 0.32, 0.1) });
  page.drawText(input.institutionName, { x: 70, y: 724, size: 18, font: serifBold, color: rgb(0.09, 0.18, 0.22), maxWidth: 450 });
  page.drawText(input.certificateTypeLabel, { x: 70, y: 692, size: 14, font: serif, color: rgb(0.15, 0.3, 0.32) });

  page.drawText("This document records an academic result for integrity testing.", {
    x: 70,
    y: 652,
    size: 11,
    font: serif,
    color: rgb(0.2, 0.2, 0.2),
  });
  page.drawText("It is not an official certificate of the Government of Nepal.", {
    x: 70,
    y: 636,
    size: 11,
    font: serif,
    color: rgb(0.2, 0.2, 0.2),
  });

  const rows: Array<[string, string]> = [
    ["Holder", input.holderName],
    ["Symbol / registration", input.symbolOrRegNo],
    ["Programme", input.programName],
    ["Campus / school", input.campusOrSchool],
    ["Academic year (BS)", input.academicYearBs],
    ["Result", input.gpaOrDivision],
    ["Issue date", input.issueDate],
    ["Certificate ID", input.certificateId],
  ];
  let y = 590;
  for (const [label, value] of rows) {
    page.drawText(label, { x: 70, y, size: 10, font: sans, color: rgb(0.35, 0.35, 0.35) });
    page.drawText(value.slice(0, 80), { x: 230, y, size: 12, font: serif, color: rgb(0.1, 0.1, 0.1) });
    y -= 28;
  }

  const qr = await QRCode.toBuffer(input.verificationUrl, { type: "png", margin: 1, width: 180 });
  const image = await pdf.embedPng(qr);
  page.drawImage(image, { x: 380, y: 120, width: 120, height: 120 });
  page.drawText("Scan to check status", { x: 386, y: 104, size: 9, font: sans, color: rgb(0.3, 0.3, 0.3) });
  page.drawText("A matching fingerprint does not prove the presenter's identity.", {
    x: 70,
    y: 70,
    size: 9,
    font: sans,
    color: rgb(0.35, 0.2, 0.15),
  });

  return Buffer.from(await pdf.save());
}
