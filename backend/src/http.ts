import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "./errors";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: "SUPER_ADMIN" | "INSTITUTION_ADMIN" | "INSTITUTION_STAFF" | "STUDENT" | "VERIFIER";
  institutionId: string | null;
  institutionStatus: string | null;
  canIssue: boolean;
  canRevoke: boolean;
  canManageStaff: boolean;
  mustChangePassword: boolean;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionCsrf?: string;
    }
  }
}

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.flatten());
  }
  return parsed.data;
}

export function pageQuery(req: Request): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function dateOnly(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${label} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, "VALIDATION_ERROR", `${label} is not a valid date`);
  return date;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const provinces = ["Koshi", "Madhesh", "Bagmati", "Gandaki", "Lumbini", "Karnali", "Sudurpashchim"] as const;

export const certificateTypeLabel: Record<string, string> = {
  SEE: "Secondary Education Examination (SEE)",
  PLUS_TWO: "Higher Secondary (+2)",
  UNIVERSITY: "University certificate",
};

export const publicLimitations = [
  "A fingerprint match shows this file was issued and has not been altered.",
  "It does not prove the legal identity of the person presenting the document.",
  "Personal details stay off the ledger. The public page omits the holder's name, date of birth, and grades.",
];
