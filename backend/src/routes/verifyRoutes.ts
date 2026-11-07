import { Router } from "express";
import multer from "multer";
import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import { sha256 } from "../crypto";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { verifyCertificate, type VerifyOutcome } from "../fabric";
import { asyncRoute, certificateTypeLabel, publicLimitations, sendData } from "../http";
import { assertSafePdf } from "../pdf";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 8 * 1024 * 1024 },
});

type PublicResult = "VALID" | "TAMPERED" | "REVOKED" | "NOT_FOUND" | "INVALID_ISSUER" | "ERROR";

function ipHash(config: AppConfig, ip: string | undefined): string | null {
  if (!ip) return null;
  return sha256(`${config.SESSION_SECRET}:${ip}`).slice(0, 24);
}

export function verifyRouter(config: AppConfig): Router {
  const router = Router();

  router.get(
    "/:certificateId",
    asyncRoute(async (req, res) => {
      const started = Date.now();
      const certificateId = req.params.certificateId;
      const payload = await runVerification(config, {
        certificateId,
        submittedHash: "",
        method: "qr",
        verifierUserId: req.user?.id ?? null,
        ip: req.ip,
        started,
        documentChecked: false,
      });
      sendData(res, payload);
    }),
  );

  router.post(
    "/",
    upload.single("document"),
    asyncRoute(async (req, res) => {
      const started = Date.now();
      if (!req.file?.buffer) throw new ApiError(400, "INVALID_FILE", "Upload the certificate PDF");
      assertSafePdf(req.file.buffer, config.MAX_UPLOAD_BYTES);
      const submittedHash = sha256(req.file.buffer);
      const certificateId = typeof req.body?.certificateId === "string" ? req.body.certificateId.trim() : "";
      const payload = await runVerification(config, {
        certificateId,
        submittedHash,
        method: "upload",
        verifierUserId: req.user?.id ?? null,
        ip: req.ip,
        started,
        documentChecked: true,
      });
      sendData(res, payload);
    }),
  );

  return router;
}

async function runVerification(
  config: AppConfig,
  input: {
    certificateId: string;
    submittedHash: string;
    method: string;
    verifierUserId: string | null;
    ip: string | undefined;
    started: number;
    documentChecked: boolean;
  },
) {
  let outcome: VerifyOutcome | null = null;
  let result: PublicResult = "ERROR";
  try {
    outcome = await verifyCertificate(input.certificateId, input.submittedHash);
    result = outcome.result;
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") {
      result = "NOT_FOUND";
    } else if (error instanceof ApiError && (error.code === "INVALID_ARGUMENT" || error.status === 400)) {
      throw error;
    } else {
      result = "ERROR";
    }
  }

  const latencyMs = Date.now() - input.started;
  const recordId = outcome?.certificateId || input.certificateId || null;
  const stored = recordId
    ? await prisma.certificate.findUnique({
        where: { id: recordId },
        include: {
          institution: { select: { name: true, type: true, status: true } },
          student: true,
          revocation: true,
        },
      })
    : null;

  await prisma.verificationLog.create({
    data: {
      certificateId: stored?.id ?? null,
      result,
      submittedSha256: input.submittedHash || null,
      method: input.method,
      verifierUserId: input.verifierUserId,
      ipHash: ipHash(config, input.ip),
      latencyMs,
    },
  });
  await writeAudit({
    actorUserId: input.verifierUserId,
    action: "certificate.verify",
    entityType: "certificate",
    entityId: stored?.id ?? recordId,
    metadata: { result, method: input.method, documentChecked: input.documentChecked, latencyMs },
  });

  const hashMatches = Boolean(input.documentChecked && outcome && input.submittedHash && outcome.sha256 === input.submittedHash);
  const revealHolder = Boolean(input.verifierUserId && hashMatches && (result === "VALID" || result === "REVOKED") && stored);

  return {
    result,
    documentChecked: input.documentChecked,
    certificateId: outcome?.certificateId || stored?.id || input.certificateId || null,
    certificateType: stored ? certificateTypeLabel[stored.type] ?? stored.type : null,
    institutionName: stored?.institution.name ?? null,
    institutionStatus: stored?.institution.status ?? null,
    issuerStatus: outcome?.issuerStatus ?? null,
    certificateStatus: outcome?.certificateStatus ?? stored?.status ?? null,
    academicYearBs: stored?.academicYearBs ?? null,
    programName: stored?.programName ?? null,
    campusOrSchool: stored?.campusOrSchool ?? null,
    issueDate: stored ? stored.issueDate.toISOString().slice(0, 10) : null,
    issuedAt: outcome?.issuedAt ?? stored?.issuedAt?.toISOString() ?? null,
    revokedAt: result === "REVOKED" ? outcome?.revokedAt ?? stored?.revocation?.revokedAt.toISOString() ?? null : null,
    verifiedAt: new Date().toISOString(),
    latencyMs,
    limitations: publicLimitations,
    message: messageFor(result, input.documentChecked),
    holder: revealHolder && stored
      ? {
          fullName: stored.student.fullName,
          dateOfBirth: stored.student.dateOfBirth.toISOString().slice(0, 10),
          symbolOrRegNo: stored.symbolOrRegNo,
          gpaOrDivision: stored.gpaOrDivision,
        }
      : null,
  };
}

function messageFor(result: PublicResult, documentChecked: boolean): string {
  if (!documentChecked && result === "VALID") {
    return "The ledger has a valid record for this identifier. The PDF itself was not compared.";
  }
  if (!documentChecked && result === "REVOKED") {
    return "This identifier was issued and later revoked. The PDF itself was not compared.";
  }
  switch (result) {
    case "VALID":
      return "The file fingerprint matches the ledger. The issuer is recognised and the certificate is not revoked.";
    case "TAMPERED":
      return "The uploaded file does not match the fingerprint recorded for this certificate.";
    case "REVOKED":
      return "The file matches a certificate that was later revoked.";
    case "NOT_FOUND":
      return "No matching record exists on the ledger.";
    case "INVALID_ISSUER":
      return "The issuer recorded for this certificate is not recognised.";
    default:
      return "Verification could not be completed because of a technical problem.";
  }
}
