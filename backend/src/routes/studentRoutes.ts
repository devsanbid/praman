import { createReadStream } from "node:fs";
import path from "node:path";
import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { writeAudit } from "../audit";
import { requireRoles, requireUser } from "../auth";
import type { AppConfig } from "../config";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { asyncRoute, dateOnly, isoDate, sendData } from "../http";
import { verificationUrl } from "./certificateRoutes";

const claimSchema = z.object({
  certificateId: z.string().trim().min(8).max(40),
  dateOfBirth: z.string(),
  symbolOrRegNo: z.string().trim().min(2).max(40),
});

export function studentRouter(config: AppConfig): Router {
  const router = Router();
  router.use(requireRoles(["STUDENT"]));

  router.get(
    "/certificates",
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      const items = await prisma.certificate.findMany({
        where: { student: { userId: user.id }, status: { in: ["VALID", "REVOKED"] } },
        include: { institution: { select: { name: true, type: true } }, revocation: true },
        orderBy: { createdAt: "desc" },
      });
      sendData(res, items.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        programName: item.programName,
        academicYearBs: item.academicYearBs,
        campusOrSchool: item.campusOrSchool,
        issueDate: isoDate(item.issueDate),
        institutionName: item.institution.name,
        verificationUrl: verificationUrl(config, item.id),
        revokedAt: item.revocation?.revokedAt.toISOString() ?? null,
      })));
    }),
  );

  router.post(
    "/certificates/claim",
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      const body = claimSchema.safeParse(req.body);
      if (!body.success) throw new ApiError(400, "VALIDATION_ERROR", "Certificate id, date of birth, and symbol number are required");
      const dob = dateOnly(body.data.dateOfBirth, "Date of birth");
      const certificate = await prisma.certificate.findUnique({
        where: { id: body.data.certificateId },
        include: { student: true },
      });
      if (!certificate || (certificate.status !== "VALID" && certificate.status !== "REVOKED")) {
        throw new ApiError(404, "NOT_FOUND", "No issued certificate matches these details");
      }
      if (certificate.symbolOrRegNo !== body.data.symbolOrRegNo || isoDate(certificate.student.dateOfBirth) !== isoDate(dob)) {
        throw new ApiError(404, "NOT_FOUND", "No issued certificate matches these details");
      }
      if (certificate.student.userId && certificate.student.userId !== user.id) {
        throw new ApiError(409, "ALREADY_CLAIMED", "This certificate is already linked to another account");
      }
      await prisma.student.update({ where: { id: certificate.studentId }, data: { userId: user.id } });
      await writeAudit({
        actorUserId: user.id,
        action: "certificate.claim",
        entityType: "certificate",
        entityId: certificate.id,
      });
      sendData(res, { id: certificate.id, status: certificate.status });
    }),
  );

  router.get(
    "/certificates/:id/document",
    asyncRoute(async (req, res) => {
      const certificate = await owned(req.params.id, requireUser(req).id);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `attachment; filename="${certificate.id}.pdf"`);
      createReadStream(path.join(config.UPLOAD_DIR, certificate.pdfStorageKey)).pipe(res);
    }),
  );

  router.get(
    "/certificates/:id/qr",
    asyncRoute(async (req, res) => {
      const certificate = await owned(req.params.id, requireUser(req).id);
      const png = await QRCode.toBuffer(verificationUrl(config, certificate.id), { type: "png", width: 360, margin: 1 });
      res.setHeader("content-type", "image/png");
      res.send(png);
    }),
  );

  return router;
}

async function owned(id: string, userId: string) {
  const certificate = await prisma.certificate.findFirst({
    where: { id, student: { userId }, status: { in: ["VALID", "REVOKED"] } },
  });
  if (!certificate) throw new ApiError(404, "NOT_FOUND", "Certificate not found");
  return certificate;
}
