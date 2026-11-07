import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import QRCode from "qrcode";
import { z } from "zod";
import { writeAudit } from "../audit";
import { assertInstitutionActive, requireRoles, requireUser } from "../auth";
import type { AppConfig } from "../config";
import { canonicalCertificateHash, newCertificateId, sha256 } from "../crypto";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { getCertificate, getCertificateHistory, issueCertificate, platformAdminMaterial, revokeCertificate } from "../fabric";
import { asyncRoute, certificateTypeLabel, dateOnly, isoDate, pageQuery, sendData } from "../http";
import { assertSafePdf, buildCertificatePdf } from "../pdf";
import { institutionSigner } from "./institutionRoutes";
import type { Certificate, Student } from "@prisma/client";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 8 * 1024 * 1024 },
});

const issueFields = z.object({
  type: z.enum(["SEE", "PLUS_TWO", "UNIVERSITY"]),
  fullName: z.string().trim().min(3).max(120),
  dateOfBirth: z.string(),
  holderEmail: z.string().trim().email().optional().or(z.literal("")),
  symbolOrRegNo: z.string().trim().min(2).max(40),
  programName: z.string().trim().min(2).max(160),
  academicYearBs: z.string().regex(/^\d{4}$/),
  academicYearAd: z.coerce.number().int().min(1950).max(2100),
  gpaOrDivision: z.string().trim().min(1).max(40),
  streamOrFaculty: z.string().trim().max(80).optional().or(z.literal("")),
  campusOrSchool: z.string().trim().min(2).max(160),
  issueDate: z.string(),
  consent: z.enum(["true", "false"]),
  documentSource: z.enum(["generate", "upload"]),
});

const revokeSchema = z.object({
  reason: z.string().trim().min(3).max(200),
});

function chainType(type: "SEE" | "PLUS_TWO" | "UNIVERSITY") {
  return type;
}

async function markChainFailure(certificateId: string, message: string) {
  await prisma.blockchainTransaction.create({
    data: { functionName: "IssueCertificate", certificateId, status: "FAILED", errorCode: message.slice(0, 120) },
  });
  await prisma.certificate.update({ where: { id: certificateId }, data: { status: "ISSUANCE_FAILED" } });
}

export function certificateRouter(config: AppConfig): Router {
  const router = Router();
  router.use(requireRoles(["INSTITUTION_ADMIN", "INSTITUTION_STAFF", "SUPER_ADMIN"]));

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      const { page, pageSize, skip } = pageQuery(req);
      const where = user.role === "SUPER_ADMIN" ? {} : { institutionId: user.institutionId ?? "none" };
      const [total, items] = await Promise.all([
        prisma.certificate.count({ where }),
        prisma.certificate.findMany({
          where,
          include: { student: true, institution: { select: { name: true } }, revocation: true },
          orderBy: { createdAt: "desc" },
          skip,
          take: pageSize,
        }),
      ]);
      sendData(res, { items, page, pageSize, total });
    }),
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const certificate = await loadOwned(req.params.id, requireUser(req));
      sendData(res, certificate);
    }),
  );

  router.get(
    "/:id/document",
    asyncRoute(async (req, res) => {
      const certificate = await loadOwned(req.params.id, requireUser(req));
      const file = path.join(config.UPLOAD_DIR, certificate.pdfStorageKey);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `attachment; filename="${certificate.id}.pdf"`);
      createReadStream(file).pipe(res);
    }),
  );

  router.get(
    "/:id/history",
    asyncRoute(async (req, res) => {
      const certificate = await loadOwned(req.params.id, requireUser(req));
      const history = await getCertificateHistory(certificate.id);
      sendData(res, history.map((entry) => ({
        txId: entry.txId,
        timestamp: entry.timestamp,
        isDelete: entry.isDelete,
        status: entry.record?.status ?? null,
      })));
    }),
  );

  router.get(
    "/:id/qr",
    asyncRoute(async (req, res) => {
      await loadOwned(req.params.id, requireUser(req));
      const png = await QRCode.toBuffer(verificationUrl(config, req.params.id), { type: "png", width: 360, margin: 1 });
      res.setHeader("content-type", "image/png");
      res.send(png);
    }),
  );

  router.post(
    "/",
    upload.single("document"),
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      if (!user.canIssue) throw new ApiError(403, "FORBIDDEN", "You are not allowed to issue certificates");
      assertInstitutionActive(user);
      const parsed = issueFields.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.flatten());
      const body = parsed.data;
      if (body.consent !== "true") {
        throw new ApiError(400, "CONSENT_REQUIRED", "Confirm that the holder was informed before a fingerprint is recorded");
      }
      const year = Number(body.academicYearBs);
      if (year < 2000 || year > 2200) throw new ApiError(400, "VALIDATION_ERROR", "Academic year (BS) is out of range");
      const institution = await prisma.institution.findUnique({ where: { id: user.institutionId ?? "" } });
      if (!institution?.fabricIssuerId) throw new ApiError(409, "ISSUER_NOT_ENROLLED", "This institution is not enrolled on the ledger");

      const idempotencyKey = req.get("idempotency-key")?.slice(0, 80) || null;
      if (idempotencyKey) {
        const prior = await prisma.certificate.findFirst({ where: { institutionId: institution.id, idempotencyKey } });
        if (prior?.status === "VALID" || prior?.status === "REVOKED") {
          sendData(res, prior);
          return;
        }
      }

      const dob = dateOnly(body.dateOfBirth, "Date of birth");
      const issueDate = dateOnly(body.issueDate, "Issue date");
      const holderEmail = body.holderEmail ? body.holderEmail.toLowerCase() : null;
      let pdf = req.file?.buffer;
      const certificateId = newCertificateId(chainType(body.type), body.academicYearBs);
      if (body.documentSource === "upload") {
        if (!pdf) throw new ApiError(400, "INVALID_FILE", "Upload the certificate PDF");
        assertSafePdf(pdf, config.MAX_UPLOAD_BYTES);
      } else {
        pdf = await buildCertificatePdf({
          certificateId,
          verificationUrl: verificationUrl(config, certificateId),
          institutionName: institution.name,
          certificateTypeLabel: certificateTypeLabel[body.type] ?? body.type,
          holderName: body.fullName,
          symbolOrRegNo: body.symbolOrRegNo,
          programName: body.programName,
          academicYearBs: body.academicYearBs,
          gpaOrDivision: body.gpaOrDivision,
          campusOrSchool: body.campusOrSchool,
          issueDate: body.issueDate,
        });
        assertSafePdf(pdf, config.MAX_UPLOAD_BYTES);
      }
      const fingerprint = sha256(pdf);
      const canonical = canonicalCertificateHash({
        type: body.type,
        fullName: body.fullName,
        dateOfBirth: isoDate(dob),
        symbolOrRegNo: body.symbolOrRegNo,
        programName: body.programName,
        academicYearBs: body.academicYearBs,
        academicYearAd: body.academicYearAd,
        gpaOrDivision: body.gpaOrDivision,
        streamOrFaculty: body.streamOrFaculty || "",
        campusOrSchool: body.campusOrSchool,
        issueDate: isoDate(issueDate),
        institutionRegistration: institution.registrationNumber,
      });

      const student = await linkStudentAccount(await upsertStudent(body.fullName, dob, holderEmail));
      await mkdir(config.UPLOAD_DIR, { recursive: true });
      const storageKey = `${certificateId}.pdf`;
      await writeFile(path.join(config.UPLOAD_DIR, storageKey), pdf, { mode: 0o640 });

      await prisma.certificate.create({
        data: {
          id: certificateId,
          type: body.type,
          status: "PENDING_CHAIN",
          institutionId: institution.id,
          studentId: student.id,
          sha256: fingerprint,
          canonicalSha256: canonical,
          pdfStorageKey: storageKey,
          pdfByteSize: pdf.length,
          originalFileName: req.file?.originalname?.replace(/[^\w.\- ]+/g, "").slice(0, 120) || null,
          programName: body.programName,
          academicYearBs: body.academicYearBs,
          academicYearAd: body.academicYearAd,
          symbolOrRegNo: body.symbolOrRegNo,
          gpaOrDivision: body.gpaOrDivision,
          streamOrFaculty: body.streamOrFaculty || null,
          campusOrSchool: body.campusOrSchool,
          issueDate,
          holderEmail,
          idempotencyKey,
          consentRecorded: true,
        },
      });

      try {
        const signer = await institutionSigner(config, institution.fabricIssuerId);
        const committed = await issueCertificate(signer, certificateId, fingerprint);
        const saved = await prisma.certificate.update({
          where: { id: certificateId },
          data: { status: "VALID", issuedAt: new Date(committed.record.issuedAt), chainTxId: committed.txId },
        });
        await prisma.blockchainTransaction.create({
          data: {
            functionName: "IssueCertificate",
            txId: committed.txId,
            certificateId,
            institutionId: institution.id,
            status: "CONFIRMED",
          },
        });
        await writeAudit({
          actorUserId: user.id,
          action: "certificate.issue",
          entityType: "certificate",
          entityId: certificateId,
          metadata: { institutionId: institution.id, txId: committed.txId, type: body.type },
        });
        sendData(res, { ...saved, verificationUrl: verificationUrl(config, certificateId) }, 201);
      } catch (error) {
        const onChain = await getCertificate(certificateId).catch(() => null);
        if (onChain && onChain.sha256 === fingerprint) {
          const saved = await prisma.certificate.update({
            where: { id: certificateId },
            data: { status: "VALID", issuedAt: new Date(onChain.issuedAt) },
          });
          sendData(res, { ...saved, verificationUrl: verificationUrl(config, certificateId) }, 201);
          return;
        }
        await markChainFailure(certificateId, error instanceof Error ? error.message : "CHAIN_ERROR");
        throw error;
      }
    }),
  );

  router.post(
    "/:id/revoke",
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      if (!user.canRevoke) throw new ApiError(403, "FORBIDDEN", "You are not allowed to revoke certificates");
      const body = revokeSchema.safeParse(req.body);
      if (!body.success) throw new ApiError(400, "VALIDATION_ERROR", "A revocation reason is required");
      const certificate = await prisma.certificate.findUnique({ where: { id: req.params.id }, include: { institution: true } });
      if (!certificate) throw new ApiError(404, "NOT_FOUND", "Certificate not found");
      const asAdmin = user.role === "SUPER_ADMIN";
      if (!asAdmin) {
        assertInstitutionActive(user);
        if (certificate.institutionId !== user.institutionId) throw new ApiError(403, "FORBIDDEN", "Only the issuing institution can revoke this certificate");
      }
      if (certificate.status !== "VALID") throw new ApiError(409, "INVALID_STATE", "Only a valid certificate can be revoked");
      const material = asAdmin
        ? await platformAdminMaterial()
        : await institutionSigner(config, certificate.institution.fabricIssuerId || "");
      const committed = await revokeCertificate(material, certificate.id, body.data.reason);
      const revokedAt = new Date(committed.record.revokedAt || new Date().toISOString());
      await prisma.$transaction([
        prisma.certificate.update({ where: { id: certificate.id }, data: { status: "REVOKED", chainTxId: committed.txId } }),
        prisma.certificateRevocation.create({
          data: { certificateId: certificate.id, reason: body.data.reason, revokedAt, revokedByUserId: user.id, chainTxId: committed.txId },
        }),
        prisma.blockchainTransaction.create({
          data: { functionName: "RevokeCertificate", txId: committed.txId, certificateId: certificate.id, institutionId: certificate.institutionId, status: "CONFIRMED" },
        }),
      ]);
      await writeAudit({
        actorUserId: user.id,
        action: "certificate.revoke",
        entityType: "certificate",
        entityId: certificate.id,
        metadata: { txId: committed.txId },
      });
      sendData(res, { id: certificate.id, status: "REVOKED", revokedAt: revokedAt.toISOString() });
    }),
  );

  return router;
}

async function loadOwned(id: string, user: ReturnType<typeof requireUser>) {
  const certificate = await prisma.certificate.findUnique({
    where: { id },
    include: { student: true, institution: { select: { id: true, name: true, type: true, status: true } }, revocation: true },
  });
  if (!certificate) throw new ApiError(404, "NOT_FOUND", "Certificate not found");
  if (user.role !== "SUPER_ADMIN" && certificate.institutionId !== user.institutionId) {
    throw new ApiError(403, "FORBIDDEN", "This certificate belongs to another institution");
  }
  return certificate;
}

async function linkStudentAccount(student: Student): Promise<Student> {
  if (!student.email || student.userId) return student;
  const account = await prisma.user.findUnique({ where: { email: student.email } });
  if (!account || account.role !== "STUDENT" || !account.isActive) return student;
  return prisma.student.update({ where: { id: student.id }, data: { userId: account.id } });
}

async function upsertStudent(fullName: string, dateOfBirth: Date, email: string | null): Promise<Student> {
  if (email) {
    const existing = await prisma.student.findFirst({ where: { email } });
    if (existing) {
      if (isoDate(existing.dateOfBirth) !== isoDate(dateOfBirth)) {
        throw new ApiError(409, "STUDENT_CONFLICT", "A student with this email has a different date of birth");
      }
      return existing;
    }
  }
  return prisma.student.create({ data: { fullName, dateOfBirth, email } });
}

export function verificationUrl(config: AppConfig, certificateId: string): string {
  return `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/verify/${certificateId}`;
}

export type IssuedCertificate = Certificate;
