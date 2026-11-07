import { Router } from "express";
import { z } from "zod";
import { verifyAuditChain, writeAudit } from "../audit";
import { requireRoles, requireUser } from "../auth";
import type { AppConfig } from "../config";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { getCertificate, pingLedger } from "../fabric";
import { asyncRoute, pageQuery, parseBody, sendData } from "../http";

const settingSchema = z.object({
  publicNotice: z.string().trim().max(500),
});

const userPatchSchema = z.object({
  isActive: z.boolean(),
});

export function adminRouter(_config: AppConfig): Router {
  const router = Router();
  router.use(requireRoles(["SUPER_ADMIN"]));

  router.get(
    "/stats",
    asyncRoute(async (_req, res) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [institutions, certificates, verifications, chain] = await Promise.all([
        prisma.institution.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.certificate.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.verificationLog.groupBy({ by: ["result"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
        pingLedger(),
      ]);
      sendData(res, {
        institutions: Object.fromEntries(institutions.map((row) => [row.status, row._count._all])),
        certificates: Object.fromEntries(certificates.map((row) => [row.status, row._count._all])),
        verificationsLast24h: Object.fromEntries(verifications.map((row) => [row.result, row._count._all])),
        chainReachable: chain,
      });
    }),
  );

  router.get(
    "/users",
    asyncRoute(async (req, res) => {
      const { page, pageSize, skip } = pageQuery(req);
      const [total, items] = await Promise.all([
        prisma.user.count(),
        prisma.user.findMany({
          skip,
          take: pageSize,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            isActive: true,
            mustChangePassword: true,
            createdAt: true,
            membership: { select: { institution: { select: { id: true, name: true, status: true } } } },
          },
        }),
      ]);
      sendData(res, { items, page, pageSize, total });
    }),
  );

  router.post(
    "/users/:id",
    asyncRoute(async (req, res) => {
      const actor = requireUser(req);
      const body = parseBody(userPatchSchema, req.body);
      if (req.params.id === actor.id && !body.isActive) {
        throw new ApiError(403, "FORBIDDEN", "You cannot deactivate your own account");
      }
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found");
      if (target.role === "SUPER_ADMIN" && !body.isActive) {
        const others = await prisma.user.count({ where: { role: "SUPER_ADMIN", isActive: true, id: { not: target.id } } });
        if (others === 0) throw new ApiError(409, "INVALID_STATE", "The last active administrator cannot be deactivated");
      }
      await prisma.user.update({ where: { id: target.id }, data: { isActive: body.isActive } });
      if (!body.isActive) await prisma.session.deleteMany({ where: { userId: target.id } });
      await writeAudit({
        actorUserId: actor.id,
        action: body.isActive ? "user.activate" : "user.deactivate",
        entityType: "user",
        entityId: target.id,
      });
      sendData(res, { id: target.id, isActive: body.isActive });
    }),
  );

  router.get(
    "/audit",
    asyncRoute(async (req, res) => {
      const { page, pageSize, skip } = pageQuery(req);
      const [total, items] = await Promise.all([
        prisma.auditLog.count(),
        prisma.auditLog.findMany({
          skip,
          take: pageSize,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            action: true,
            entityType: true,
            entityId: true,
            createdAt: true,
            entryHash: true,
            actor: { select: { id: true, role: true } },
          },
        }),
      ]);
      sendData(res, { items, page, pageSize, total });
    }),
  );

  router.get(
    "/audit/verify",
    asyncRoute(async (_req, res) => {
      sendData(res, await verifyAuditChain());
    }),
  );

  router.get(
    "/settings",
    asyncRoute(async (_req, res) => {
      const row = await prisma.systemSetting.findUnique({ where: { key: "publicNotice" } });
      const value = typeof row?.value === "string" ? row.value : "";
      sendData(res, { publicNotice: value });
    }),
  );

  router.put(
    "/settings",
    asyncRoute(async (req, res) => {
      const actor = requireUser(req);
      const body = parseBody(settingSchema, req.body);
      await prisma.systemSetting.upsert({
        where: { key: "publicNotice" },
        create: { key: "publicNotice", value: body.publicNotice },
        update: { value: body.publicNotice },
      });
      await writeAudit({
        actorUserId: actor.id,
        action: "settings.update",
        entityType: "setting",
        entityId: "publicNotice",
      });
      sendData(res, { publicNotice: body.publicNotice });
    }),
  );

  router.post(
    "/certificates/:id/reconcile",
    asyncRoute(async (req, res) => {
      const actor = requireUser(req);
      const certificate = await prisma.certificate.findUnique({ where: { id: req.params.id } });
      if (!certificate) throw new ApiError(404, "NOT_FOUND", "Certificate not found");
      let onChain: Awaited<ReturnType<typeof getCertificate>> | null = null;
      try {
        onChain = await getCertificate(certificate.id);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
      }
      if (!onChain) {
        if (certificate.status === "PENDING_CHAIN") {
          await prisma.certificate.update({ where: { id: certificate.id }, data: { status: "ISSUANCE_FAILED" } });
        }
        await writeAudit({ actorUserId: actor.id, action: "certificate.reconcile", entityType: "certificate", entityId: certificate.id, metadata: { found: false } });
        sendData(res, { id: certificate.id, status: certificate.status === "PENDING_CHAIN" ? "ISSUANCE_FAILED" : certificate.status, onChain: false });
        return;
      }
      if (onChain.sha256 !== certificate.sha256) {
        throw new ApiError(409, "HASH_MISMATCH", "The ledger fingerprint does not match the stored file hash");
      }
      if (onChain.status === "VALID") {
        await prisma.certificate.update({
          where: { id: certificate.id },
          data: { status: "VALID", issuedAt: new Date(onChain.issuedAt) },
        });
      } else if (onChain.status === "REVOKED") {
        const revokedAt = new Date(onChain.revokedAt || new Date().toISOString());
        await prisma.certificate.update({ where: { id: certificate.id }, data: { status: "REVOKED" } });
        await prisma.certificateRevocation.upsert({
          where: { certificateId: certificate.id },
          create: {
            certificateId: certificate.id,
            reason: onChain.revocationReason || "Reconciled from the ledger",
            revokedAt,
            revokedByUserId: actor.id,
          },
          update: { revokedAt },
        });
      }
      await writeAudit({
        actorUserId: actor.id,
        action: "certificate.reconcile",
        entityType: "certificate",
        entityId: certificate.id,
        metadata: { status: onChain.status },
      });
      sendData(res, { id: certificate.id, status: onChain.status, onChain: true });
    }),
  );

  return router;
}

export async function publicNotice(): Promise<string> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "publicNotice" } });
  return typeof row?.value === "string" ? row.value : "";
}
