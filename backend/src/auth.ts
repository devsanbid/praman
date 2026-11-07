import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import { sha256 } from "./crypto";
import { prisma } from "./db";
import { ApiError } from "./errors";
import type { AuthUser } from "./http";

const SESSION_COOKIE = "praman_session";
const CSRF_COOKIE = "praman_csrf";

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}

export function cookieOptions(config: AppConfig, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.PUBLIC_APP_URL.startsWith("https://"),
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function publicCookieOptions(config: AppConfig, maxAgeMs: number) {
  return { ...cookieOptions(config, maxAgeMs), httpOnly: false };
}

export async function loadSession(config: AppConfig, req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) {
      next();
      return;
    }
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        user: { include: { membership: { include: { institution: true } } } },
      },
    });
    if (!session || session.expiresAt.getTime() < Date.now() || !session.user.isActive) {
      next();
      return;
    }
    const user = session.user;
    const membership = user.membership;
    const admin = user.role === "INSTITUTION_ADMIN";
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      institutionId: membership?.institutionId ?? null,
      institutionStatus: membership?.institution.status ?? null,
      canIssue: user.role === "SUPER_ADMIN" || admin || Boolean(membership?.canIssue),
      canRevoke: user.role === "SUPER_ADMIN" || admin || Boolean(membership?.canRevoke),
      canManageStaff: user.role === "SUPER_ADMIN" || admin || Boolean(membership?.canManageStaff),
      mustChangePassword: user.mustChangePassword,
    };
    req.sessionCsrf = session.csrfToken;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue");
  return req.user;
}

export function requirePasswordCurrent(req: Request): AuthUser {
  const user = requireUser(req);
  if (user.mustChangePassword) {
    throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Change the temporary password before continuing");
  }
  return user;
}

export function requireRoles(roles: AuthUser["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = requirePasswordCurrent(req);
      if (!roles.includes(user.role)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this action");
      next();
    } catch (error) {
      next(error);
    }
  };
}

const csrfExempt = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/institutions/applications",
  "/api/v1/verify",
]);

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (!req.cookies?.[SESSION_COOKIE]) {
    next();
    return;
  }
  if (csrfExempt.has(req.path)) {
    next();
    return;
  }
  const header = req.get("x-csrf-token");
  if (!header || !req.sessionCsrf || header !== req.sessionCsrf) {
    next(new ApiError(403, "CSRF_FAILED", "The request failed the CSRF check"));
    return;
  }
  next();
}

export function assertInstitutionActive(user: AuthUser): void {
  if (user.role === "SUPER_ADMIN") return;
  if (!user.institutionId || user.institutionStatus !== "APPROVED") {
    throw new ApiError(403, "INSTITUTION_INACTIVE", "This institution is not approved to issue certificates");
  }
}
