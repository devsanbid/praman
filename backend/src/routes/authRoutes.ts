import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../audit";
import { cookieOptions, csrfCookieName, publicCookieOptions, requireUser, sessionCookieName } from "../auth";
import type { AppConfig } from "../config";
import { assertPasswordPolicy, hashPassword, randomToken, sha256, verifyPassword } from "../crypto";
import { prisma } from "../db";
import { ApiError } from "../errors";
import { asyncRoute, parseBody, sendData, type AuthUser } from "../http";

const registerSchema = z.object({
  role: z.enum(["STUDENT", "VERIFIER"]),
  fullName: z.string().trim().min(3).max(120),
  email: z.string().trim().email().max(160),
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

function toClient(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    institutionId: user.institutionId,
    canIssue: user.canIssue,
    canRevoke: user.canRevoke,
    canManageStaff: user.canManageStaff,
    mustChangePassword: user.mustChangePassword,
    institutionStatus: user.institutionStatus,
  };
}

async function sessionFor(userId: string, config: AppConfig, req: { ip?: string; get(name: string): string | undefined }) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const ttl = config.SESSION_TTL_HOURS * 60 * 60 * 1000;
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfToken,
      expiresAt: new Date(Date.now() + ttl),
      ipHash: req.ip ? sha256(`${config.SESSION_SECRET}:${req.ip}`).slice(0, 24) : null,
      userAgent: req.get("user-agent")?.slice(0, 200) ?? null,
    },
  });
  return { token, csrfToken, ttl };
}

export function authRouter(config: AppConfig): Router {
  const router = Router();

  router.post(
    "/register",
    asyncRoute(async (req, res) => {
      const body = parseBody(registerSchema, req.body);
      const email = body.email.toLowerCase();
      assertPasswordPolicy(body.password, email);
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists");
      const user = await prisma.user.create({
        data: {
          email,
          fullName: body.fullName,
          role: body.role,
          passwordHash: await hashPassword(body.password),
        },
      });
      await writeAudit({ actorUserId: user.id, action: "auth.register", entityType: "user", entityId: user.id, metadata: { role: body.role } });
      const session = await sessionFor(user.id, config, req);
      res.cookie(sessionCookieName(), session.token, cookieOptions(config, session.ttl));
      res.cookie(csrfCookieName(), session.csrfToken, publicCookieOptions(config, session.ttl));
      const authUser: AuthUser = {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        institutionId: null,
        institutionStatus: null,
        canIssue: false,
        canRevoke: false,
        canManageStaff: false,
        mustChangePassword: false,
      };
      sendData(res, { user: toClient(authUser), csrfToken: session.csrfToken }, 201);
    }),
  );

  router.post(
    "/login",
    asyncRoute(async (req, res) => {
      const body = parseBody(loginSchema, req.body);
      const email = body.email.toLowerCase();
      const user = await prisma.user.findUnique({
        where: { email },
        include: { membership: { include: { institution: true } } },
      });
      if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw new ApiError(429, "ACCOUNT_LOCKED", "Too many attempts. Try again later");
      }
      const valid = user ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!user || !valid || !user.isActive) {
        if (user) {
          const failed = user.failedLoginCount + 1;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginCount: failed,
              lockedUntil: failed >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
            },
          });
        }
        await writeAudit({
          action: "auth.login_failed",
          entityType: "user",
          metadata: { emailHash: sha256(email).slice(0, 16) },
        });
        throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
      }
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      const session = await sessionFor(user.id, config, req);
      res.cookie(sessionCookieName(), session.token, cookieOptions(config, session.ttl));
      res.cookie(csrfCookieName(), session.csrfToken, publicCookieOptions(config, session.ttl));
      await writeAudit({ actorUserId: user.id, action: "auth.login", entityType: "user", entityId: user.id, metadata: { role: user.role } });
      const authUser: AuthUser = {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        institutionId: user.membership?.institutionId ?? null,
        institutionStatus: user.membership?.institution.status ?? null,
        canIssue: user.role === "SUPER_ADMIN" || user.role === "INSTITUTION_ADMIN" || Boolean(user.membership?.canIssue),
        canRevoke: user.role === "SUPER_ADMIN" || user.role === "INSTITUTION_ADMIN" || Boolean(user.membership?.canRevoke),
        canManageStaff: user.role === "SUPER_ADMIN" || user.role === "INSTITUTION_ADMIN" || Boolean(user.membership?.canManageStaff),
        mustChangePassword: user.mustChangePassword,
      };
      sendData(res, { user: toClient(authUser), csrfToken: session.csrfToken });
    }),
  );

  router.post(
    "/logout",
    asyncRoute(async (req, res) => {
      const token = req.cookies?.[sessionCookieName()] as string | undefined;
      if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
      if (req.user) await writeAudit({ actorUserId: req.user.id, action: "auth.logout", entityType: "user", entityId: req.user.id });
      res.clearCookie(sessionCookieName(), { path: "/" });
      res.clearCookie(csrfCookieName(), { path: "/" });
      sendData(res, { signedOut: true });
    }),
  );

  router.get(
    "/me",
    asyncRoute(async (req, res) => {
      sendData(res, { user: toClient(requireUser(req)) });
    }),
  );

  router.post(
    "/change-password",
    asyncRoute(async (req, res) => {
      const user = requireUser(req);
      const body = parseBody(passwordSchema, req.body);
      assertPasswordPolicy(body.newPassword, user.email);
      const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!(await verifyPassword(body.currentPassword, record.passwordHash))) {
        throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
      });
      await prisma.session.deleteMany({ where: { userId: user.id } });
      const session = await sessionFor(user.id, config, req);
      res.cookie(sessionCookieName(), session.token, cookieOptions(config, session.ttl));
      res.cookie(csrfCookieName(), session.csrfToken, publicCookieOptions(config, session.ttl));
      await writeAudit({ actorUserId: user.id, action: "auth.password_changed", entityType: "user", entityId: user.id });
      sendData(res, { user: toClient({ ...user, mustChangePassword: false }), csrfToken: session.csrfToken });
    }),
  );

  return router;
}
