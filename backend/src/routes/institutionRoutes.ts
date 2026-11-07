import { existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../audit";
import { assertInstitutionActive, requireRoles, requireUser } from "../auth";
import type { AppConfig } from "../config";
import { assertPasswordPolicy, hashPassword, newIssuerId } from "../crypto";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { enrollInstitution, issuerMaterial, registerIssuer, setIssuerStatus } from "../fabric";
import { asyncRoute, pageQuery, parseBody, provinces, sendData } from "../http";

const applicationSchema = z.object({
  name: z.string().trim().min(3).max(160),
  type: z.enum(["SEE_BOARD", "PLUS_TWO", "UNIVERSITY"]),
  registrationNumber: z.string().trim().min(3).max(64),
  addressLine: z.string().trim().min(3).max(200),
  district: z.string().trim().min(2).max(80),
  province: z.enum(provinces),
  phone: z.string().trim().min(7).max(20),
  email: z.string().trim().email().max(160),
  website: z.string().trim().url().max(200).optional().or(z.literal("")),
  representativeName: z.string().trim().min(3).max(120),
  representativeTitle: z.string().trim().min(2).max(80),
  representativeEmail: z.string().trim().email().max(160),
  password: z.string().min(12).max(128),
});

const staffSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  email: z.string().trim().email(),
  password: z.string().min(12).max(128),
  jobTitle: z.string().trim().min(2).max(80),
  canIssue: z.boolean(),
  canRevoke: z.boolean(),
});

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

function walletPaths(config: AppConfig, issuerId: string) {
  const dir = path.join(config.WALLET_DIR, "issuers", issuerId);
  return { certPath: path.join(dir, "cert.pem"), keyPath: path.join(dir, "key.pem") };
}

export function institutionRouter(config: AppConfig): Router {
  const router = Router();

  router.post(
    "/applications",
    asyncRoute(async (req, res) => {
      const body = parseBody(applicationSchema, req.body);
      const email = body.representativeEmail.toLowerCase();
      assertPasswordPolicy(body.password, email);
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists");
      const registration = body.registrationNumber;
      const duplicate = await prisma.institution.findUnique({ where: { registrationNumber: registration } });
      if (duplicate) throw new ApiError(409, "REGISTRATION_IN_USE", "This registration number is already on file");

      const created = await prisma.$transaction(async (tx) => {
        const institution = await tx.institution.create({
          data: {
            name: body.name,
            type: body.type,
            registrationNumber: registration,
            addressLine: body.addressLine,
            district: body.district,
            province: body.province,
            phone: body.phone,
            email: body.email.toLowerCase(),
            website: body.website || null,
            representativeName: body.representativeName,
            representativeTitle: body.representativeTitle,
          },
        });
        const user = await tx.user.create({
          data: {
            email,
            fullName: body.representativeName,
            role: "INSTITUTION_ADMIN",
            isActive: false,
            passwordHash: await hashPassword(body.password),
            membership: {
              create: {
                institutionId: institution.id,
                jobTitle: body.representativeTitle,
                canIssue: true,
                canRevoke: true,
                canManageStaff: true,
              },
            },
          },
        });
        return { institution, user };
      });
      await writeAudit({
        actorUserId: created.user.id,
        action: "institution.apply",
        entityType: "institution",
        entityId: created.institution.id,
        metadata: { type: body.type },
      });
      sendData(res, { id: created.institution.id, status: "PENDING" }, 201);
    }),
  );

  router.get(
    "/me",
    requireRoles(["INSTITUTION_ADMIN", "INSTITUTION_STAFF", "SUPER_ADMIN"]),
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      if (!user.institutionId) throw new ApiError(404, "NOT_FOUND", "No institution is linked to this account");
      const institution = await prisma.institution.findUnique({ where: { id: user.institutionId } });
      sendData(res, institution);
    }),
  );

  router.get(
    "/staff",
    requireRoles(["INSTITUTION_ADMIN", "SUPER_ADMIN"]),
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      if (!user.institutionId) throw new ApiError(404, "NOT_FOUND", "No institution is linked to this account");
      const staff = await prisma.institutionMember.findMany({
        where: { institutionId: user.institutionId },
        include: { user: { select: { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true } } },
        orderBy: { createdAt: "asc" },
      });
      sendData(res, staff.map((member) => ({
        id: member.id,
        jobTitle: member.jobTitle,
        canIssue: member.canIssue,
        canRevoke: member.canRevoke,
        canManageStaff: member.canManageStaff,
        user: member.user,
      })));
    }),
  );

  router.post(
    "/staff",
    requireRoles(["INSTITUTION_ADMIN"]),
    asyncRoute(async (req, res) => {
      const actor = requireUser(req);
      assertInstitutionActive(actor);
      if (!actor.canManageStaff || !actor.institutionId) throw new ApiError(403, "FORBIDDEN", "You cannot manage staff");
      const body = parseBody(staffSchema, req.body);
      const email = body.email.toLowerCase();
      assertPasswordPolicy(body.password, email);
      if (await prisma.user.findUnique({ where: { email } })) {
        throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists");
      }
      const user = await prisma.user.create({
        data: {
          email,
          fullName: body.fullName,
          role: "INSTITUTION_STAFF",
          mustChangePassword: true,
          passwordHash: await hashPassword(body.password),
          membership: {
            create: {
              institutionId: actor.institutionId,
              jobTitle: body.jobTitle,
              canIssue: body.canIssue,
              canRevoke: body.canRevoke,
              canManageStaff: false,
            },
          },
        },
      });
      await writeAudit({
        actorUserId: actor.id,
        action: "staff.create",
        entityType: "user",
        entityId: user.id,
        metadata: { institutionId: actor.institutionId, canIssue: body.canIssue, canRevoke: body.canRevoke },
      });
      sendData(res, { id: user.id, email: user.email, mustChangePassword: true }, 201);
    }),
  );

  router.post(
    "/staff/:userId/deactivate",
    requireRoles(["INSTITUTION_ADMIN"]),
    asyncRoute(async (req, res) => {
      const actor = requireUser(req);
      if (!actor.institutionId) throw new ApiError(403, "FORBIDDEN", "You cannot manage staff");
      const member = await prisma.institutionMember.findFirst({
        where: { userId: req.params.userId, institutionId: actor.institutionId },
        include: { user: true },
      });
      if (!member) throw new ApiError(404, "NOT_FOUND", "Staff member not found");
      if (member.user.role === "INSTITUTION_ADMIN") {
        throw new ApiError(403, "FORBIDDEN", "The institution administrator account cannot be deactivated here");
      }
      await prisma.user.update({ where: { id: member.userId }, data: { isActive: false } });
      await prisma.session.deleteMany({ where: { userId: member.userId } });
      await writeAudit({ actorUserId: actor.id, action: "staff.deactivate", entityType: "user", entityId: member.userId });
      sendData(res, { id: member.userId, isActive: false });
    }),
  );

  return router;
}

export async function approveInstitution(config: AppConfig, institutionId: string, actorId: string) {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new ApiError(404, "NOT_FOUND", "Institution not found");
  if (institution.status !== "PENDING" && institution.status !== "REJECTED") {
    throw new ApiError(409, "INVALID_STATE", "Only a pending or rejected application can be approved");
  }
  const issuerId = institution.fabricIssuerId ?? newIssuerId();
  if (!institution.fabricIssuerId) {
    await prisma.institution.update({
      where: { id: institution.id },
      data: { fabricIssuerId: issuerId, fabricEnrollmentId: issuerId },
    });
  }
  const paths = walletPaths(config, issuerId);
  if (!existsSync(paths.certPath) || !existsSync(paths.keyPath)) {
    try {
      await enrollInstitution(issuerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/already registered|already exists/i.test(message)) {
        throw new ApiError(409, "ISSUER_KEY_MISSING", "The institution identity exists at the CA, but the key is not on this server");
      }
      throw error;
    }
  }
  let txId: string | null = null;
  try {
    txId = await registerIssuer(issuerId, institution.id, issuerId);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "ALREADY_EXISTS") throw error;
  }
  await prisma.$transaction(async (tx) => {
    await tx.institution.update({
      where: { id: institution.id },
      data: {
        status: "APPROVED",
        fabricIssuerId: issuerId,
        fabricEnrollmentId: issuerId,
        approvedAt: new Date(),
        suspendedAt: null,
        rejectionReason: null,
      },
    });
    await tx.user.updateMany({
      where: { membership: { institutionId: institution.id }, role: "INSTITUTION_ADMIN" },
      data: { isActive: true },
    });
    if (txId) {
      await tx.blockchainTransaction.create({
        data: { functionName: "RegisterIssuer", txId, institutionId: institution.id, status: "CONFIRMED" },
      });
    }
  });
  await writeAudit({
    actorUserId: actorId,
    action: "institution.approve",
    entityType: "institution",
    entityId: institution.id,
    metadata: { issuerId },
  });
  return prisma.institution.findUniqueOrThrow({ where: { id: institution.id } });
}

export async function suspendInstitution(config: AppConfig, institutionId: string, actorId: string, suspend: boolean) {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution?.fabricIssuerId) throw new ApiError(409, "INVALID_STATE", "The institution has no blockchain identity");
  if (suspend && institution.status !== "APPROVED") throw new ApiError(409, "INVALID_STATE", "Only an approved institution can be suspended");
  if (!suspend && institution.status !== "SUSPENDED") throw new ApiError(409, "INVALID_STATE", "The institution is not suspended");
  const txId = await setIssuerStatus(institution.fabricIssuerId, !suspend);
  await prisma.$transaction([
    prisma.institution.update({
      where: { id: institution.id },
      data: suspend ? { status: "SUSPENDED", suspendedAt: new Date() } : { status: "APPROVED", suspendedAt: null },
    }),
    prisma.blockchainTransaction.create({
      data: {
        functionName: suspend ? "SuspendIssuer" : "ReactivateIssuer",
        txId,
        institutionId: institution.id,
        status: "CONFIRMED",
      },
    }),
  ]);
  await writeAudit({
    actorUserId: actorId,
    action: suspend ? "institution.suspend" : "institution.reactivate",
    entityType: "institution",
    entityId: institution.id,
  });
}

export async function rejectInstitution(institutionId: string, actorId: string, reason: string) {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution || institution.status !== "PENDING") throw new ApiError(409, "INVALID_STATE", "Only a pending application can be rejected");
  await prisma.institution.update({ where: { id: institution.id }, data: { status: "REJECTED", rejectionReason: reason } });
  await writeAudit({
    actorUserId: actorId,
    action: "institution.reject",
    entityType: "institution",
    entityId: institution.id,
    metadata: { reason },
  });
}

export function adminInstitutionRouter(config: AppConfig): Router {
  const router = Router();
  router.use(requireRoles(["SUPER_ADMIN"]));

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const { page, pageSize, skip } = pageQuery(req);
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const where = status ? { status: status as "PENDING" } : {};
      const [total, rows] = await Promise.all([
        prisma.institution.count({ where }),
        prisma.institution.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
      ]);
      sendData(res, { items: rows, page, pageSize, total });
    }),
  );

  router.post("/:id/approve", asyncRoute(async (req, res) => {
    const user = requireUser(req);
    sendData(res, await approveInstitution(config, req.params.id, user.id));
  }));

  router.post("/:id/reject", asyncRoute(async (req, res) => {
    const user = requireUser(req);
    const body = parseBody(reasonSchema, req.body);
    await rejectInstitution(req.params.id, user.id, body.reason);
    sendData(res, { id: req.params.id, status: "REJECTED" });
  }));

  router.post("/:id/suspend", asyncRoute(async (req, res) => {
    const user = requireUser(req);
    await suspendInstitution(config, req.params.id, user.id, true);
    sendData(res, { id: req.params.id, status: "SUSPENDED" });
  }));

  router.post("/:id/reactivate", asyncRoute(async (req, res) => {
    const user = requireUser(req);
    await suspendInstitution(config, req.params.id, user.id, false);
    sendData(res, { id: req.params.id, status: "APPROVED" });
  }));

  return router;
}

export async function institutionSigner(config: AppConfig, issuerId: string) {
  const paths = walletPaths(config, issuerId);
  if (!existsSync(paths.certPath)) throw new ApiError(409, "ISSUER_KEY_MISSING", "The institution blockchain key is not available on this server");
  return issuerMaterial(paths.certPath, paths.keyPath);
}
