import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password, ARGON);
  } catch {
    return false;
  }
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newCertificateId(type: "SEE" | "PLUS_TWO" | "UNIVERSITY", yearBs: string): string {
  const prefix = type === "SEE" ? "SEE" : type === "PLUS_TWO" ? "P2" : "UNI";
  const raw = randomBytes(10);
  let body = "";
  for (const byte of raw) body += CROCKFORD[byte % CROCKFORD.length];
  return `NPL-${prefix}-${yearBs}-${body}`;
}

export function newIssuerId(): string {
  return `iss-${randomBytes(9).toString("hex")}`;
}

export type CanonicalFields = {
  type: string;
  fullName: string;
  dateOfBirth: string;
  symbolOrRegNo: string;
  programName: string;
  academicYearBs: string;
  academicYearAd: number;
  gpaOrDivision: string;
  streamOrFaculty: string;
  campusOrSchool: string;
  issueDate: string;
  institutionRegistration: string;
};

export function canonicalCertificateHash(fields: CanonicalFields): string {
  const normalized: Record<string, string | number> = {
    academicYearAd: fields.academicYearAd,
    academicYearBs: fields.academicYearBs.trim(),
    campusOrSchool: fields.campusOrSchool.trim().normalize("NFC"),
    dateOfBirth: fields.dateOfBirth,
    fullName: fields.fullName.trim().normalize("NFC"),
    gpaOrDivision: fields.gpaOrDivision.trim().normalize("NFC"),
    institutionRegistration: fields.institutionRegistration.trim(),
    issueDate: fields.issueDate,
    programName: fields.programName.trim().normalize("NFC"),
    streamOrFaculty: fields.streamOrFaculty.trim().normalize("NFC"),
    symbolOrRegNo: fields.symbolOrRegNo.trim(),
    type: fields.type,
  };
  return sha256(stableStringify(normalized));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function assertPasswordPolicy(password: string, email: string): void {
  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must include a letter and a number");
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    throw new Error("Password must not match the email address");
  }
}
