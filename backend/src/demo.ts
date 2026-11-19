import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import { canonicalCertificateHash, hashPassword, newCertificateId, sha256 } from "./crypto";
import { prisma } from "./db";
import { getCertificate, issueCertificate } from "./fabric";
import { logger } from "./logger";
import { buildCertificatePdf } from "./pdf";
import { writeAudit } from "./audit";
import { approveInstitution, institutionSigner } from "./routes/institutionRoutes";
import { verificationUrl } from "./routes/certificateRoutes";

/** Shared prototype password. It is shown on the home page for the assignment demo. */
export const DEMO_PASSWORD = "PramanDemo2082";

const DEMO_CERT_KEY = "demo-university-student";

export type DemoAccount = {
  label: string;
  email: string;
  password: string;
  hint: string;
};

export function demoDirectory(adminEmail: string): DemoAccount[] {
  return [
    { label: "Administrator", email: adminEmail, password: DEMO_PASSWORD, hint: "Approve institutions, users, and the audit log" },
    { label: "Valley Examination Board", email: "see@praman.demo", password: DEMO_PASSWORD, hint: "Issue an SEE certificate" },
    { label: "Capital Higher Secondary School", email: "plus2@praman.demo", password: DEMO_PASSWORD, hint: "Issue a higher-secondary certificate" },
    { label: "Himalaya University", email: "university@praman.demo", password: DEMO_PASSWORD, hint: "Issue a bachelor certificate" },
    { label: "Rahul Shrestha", email: "student@praman.demo", password: DEMO_PASSWORD, hint: "Open the bachelor certificate" },
    { label: "Nabin Karki", email: "verifier@praman.demo", password: DEMO_PASSWORD, hint: "Check a certificate file" },
  ];
}

const institutions = [
  {
    name: "Valley Examination Board",
    type: "SEE_BOARD" as const,
    registrationNumber: "DEMO-SEE-2082",
    email: "see@praman.demo",
    representativeName: "Bikash Sharma",
    representativeTitle: "Controller of Examinations",
    addressLine: "Exhibition Road, Kathmandu",
  },
  {
    name: "Capital Higher Secondary School",
    type: "PLUS_TWO" as const,
    registrationNumber: "DEMO-P2-2082",
    email: "plus2@praman.demo",
    representativeName: "Anita Gurung",
    representativeTitle: "Principal",
    addressLine: "Baneshwor, Kathmandu",
  },
  {
    name: "Himalaya University",
    type: "UNIVERSITY" as const,
    registrationNumber: "DEMO-UNI-2082",
    email: "university@praman.demo",
    representativeName: "Suresh Adhikari",
    representativeTitle: "Controller of Examinations",
    addressLine: "Kirtipur, Kathmandu",
  },
];

export async function ensureDemoAccounts(config: AppConfig, chainReachable: boolean): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const admin = await prisma.user.upsert({
    where: { email: config.ADMIN_EMAIL.toLowerCase() },
    update: {
      fullName: config.ADMIN_NAME,
      role: "SUPER_ADMIN",
      passwordHash,
      isActive: true,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    create: {
      email: config.ADMIN_EMAIL.toLowerCase(),
      fullName: config.ADMIN_NAME,
      role: "SUPER_ADMIN",
      passwordHash,
      isActive: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "student@praman.demo" },
    update: { fullName: "Rahul Shrestha", role: "STUDENT", passwordHash, isActive: true, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    create: { email: "student@praman.demo", fullName: "Rahul Shrestha", role: "STUDENT", passwordHash, isActive: true },
  });
  await prisma.student.updateMany({ where: { email: "student@praman.demo" }, data: { fullName: "Rahul Shrestha" } });
  await prisma.user.upsert({
    where: { email: "verifier@praman.demo" },
    update: { fullName: "Nabin Karki", role: "VERIFIER", passwordHash, isActive: true, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    create: { email: "verifier@praman.demo", fullName: "Nabin Karki", role: "VERIFIER", passwordHash, isActive: true },
  });

  for (const spec of institutions) {
    try {
      await ensureInstitution(config, spec, passwordHash, admin.id, chainReachable);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : error, registrationNumber: spec.registrationNumber }, "demo institution was not prepared");
    }
  }

  if (chainReachable) {
    try {
      await ensureSampleCertificate(config);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : error }, "sample certificate was not issued");
    }
  }
  logger.info("prototype demo accounts are ready");
}

async function ensureInstitution(
  config: AppConfig,
  spec: (typeof institutions)[number],
  passwordHash: string,
  adminId: string,
  chainReachable: boolean,
): Promise<void> {
  let institution = await prisma.institution.findUnique({ where: { registrationNumber: spec.registrationNumber } });
  if (!institution) {
    institution = await prisma.institution.create({
      data: {
        name: spec.name,
        type: spec.type,
        registrationNumber: spec.registrationNumber,
        addressLine: spec.addressLine,
        district: "Kathmandu",
        province: "Bagmati",
        phone: "9800000000",
        email: spec.email,
        representativeName: spec.representativeName,
        representativeTitle: spec.representativeTitle,
        status: "PENDING",
        members: {
          create: {
            jobTitle: spec.representativeTitle,
            canIssue: true,
            canRevoke: true,
            canManageStaff: true,
            user: {
              create: {
                email: spec.email,
                fullName: spec.representativeName,
                role: "INSTITUTION_ADMIN",
                isActive: false,
                mustChangePassword: false,
                passwordHash,
              },
            },
          },
        },
      },
    });
  }

  institution = await prisma.institution.update({
    where: { id: institution.id },
    data: {
      name: spec.name,
      representativeName: spec.representativeName,
      representativeTitle: spec.representativeTitle,
      addressLine: spec.addressLine,
      district: "Kathmandu",
      province: "Bagmati",
      email: spec.email,
    },
  });

  const member = await prisma.institutionMember.findFirst({ where: { institutionId: institution.id } });
  if (member) {
    await prisma.institutionMember.update({ where: { id: member.id }, data: { jobTitle: spec.representativeTitle } });
    await prisma.user.update({
      where: { id: member.userId },
      data: {
        email: spec.email,
        fullName: spec.representativeName,
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        isActive: institution.status === "APPROVED",
      },
    });
  }

  if (institution.status === "APPROVED") return;
  if (!chainReachable) {
    logger.warn({ registrationNumber: spec.registrationNumber }, "demo institution left pending because the ledger is down");
    return;
  }
  await approveInstitution(config, institution.id, adminId);
}

async function ensureSampleCertificate(config: AppConfig): Promise<void> {
  const institution = await prisma.institution.findUnique({ where: { registrationNumber: "DEMO-UNI-2082" } });
  if (!institution?.fabricIssuerId || institution.status !== "APPROVED") return;
  const existing = await prisma.certificate.findFirst({ where: { institutionId: institution.id, idempotencyKey: DEMO_CERT_KEY } });
  if (existing?.status === "VALID" || existing?.status === "REVOKED") return;

  const studentUser = await prisma.user.findUnique({ where: { email: "student@praman.demo" } });
  const issuer = await prisma.institutionMember.findFirst({ where: { institutionId: institution.id } });
  if (!studentUser || !issuer) return;

  const dateOfBirth = new Date(Date.UTC(2004, 2, 15));
  const issueDate = new Date(Date.UTC(2025, 11, 1));
  const foundStudent = existing
    ? await prisma.student.findUnique({ where: { id: existing.studentId } })
    : await prisma.student.findFirst({ where: { email: studentUser.email } });
  const student = foundStudent
    ? await prisma.student.update({ where: { id: foundStudent.id }, data: { userId: studentUser.id, fullName: "Rahul Shrestha", email: studentUser.email, dateOfBirth } })
    : await prisma.student.create({ data: { fullName: "Rahul Shrestha", dateOfBirth, email: studentUser.email, userId: studentUser.id } });

  const certificateId = existing?.id ?? newCertificateId("UNIVERSITY", "2081");
  const fields = {
    certificateId,
    verificationUrl: verificationUrl(config, certificateId),
    institutionName: institution.name,
    certificateTypeLabel: "University",
    holderName: "Rahul Shrestha",
    symbolOrRegNo: "20810042",
    programName: "Bachelor of Computer Science",
    academicYearBs: "2081",
    gpaOrDivision: "3.62",
    campusOrSchool: "Central Campus, Himalaya University",
    issueDate: "2025-12-01",
  };
  const pdf = await buildCertificatePdf(fields);
  const fingerprint = sha256(pdf);
  const canonical = canonicalCertificateHash({
    type: "UNIVERSITY",
    fullName: fields.holderName,
    dateOfBirth: "2004-03-15",
    symbolOrRegNo: fields.symbolOrRegNo,
    programName: fields.programName,
    academicYearBs: fields.academicYearBs,
    academicYearAd: 2024,
    gpaOrDivision: fields.gpaOrDivision,
    streamOrFaculty: "Science",
    campusOrSchool: fields.campusOrSchool,
    issueDate: fields.issueDate,
    institutionRegistration: institution.registrationNumber,
  });
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(config.UPLOAD_DIR, `${certificateId}.pdf`), pdf, { mode: 0o640 });

  if (!existing) {
    await prisma.certificate.create({
      data: {
        id: certificateId,
        type: "UNIVERSITY",
        status: "PENDING_CHAIN",
        institutionId: institution.id,
        studentId: student.id,
        sha256: fingerprint,
        canonicalSha256: canonical,
        pdfStorageKey: `${certificateId}.pdf`,
        pdfByteSize: pdf.length,
        programName: fields.programName,
        academicYearBs: fields.academicYearBs,
        academicYearAd: 2024,
        symbolOrRegNo: fields.symbolOrRegNo,
        gpaOrDivision: fields.gpaOrDivision,
        streamOrFaculty: "Science",
        campusOrSchool: fields.campusOrSchool,
        issueDate,
        holderEmail: studentUser.email,
        idempotencyKey: DEMO_CERT_KEY,
        consentRecorded: true,
      },
    });
  }

  const signer = await institutionSigner(config, institution.fabricIssuerId);
  let txId: string | null = null;
  let issuedAt = new Date().toISOString();
  try {
    const committed = await issueCertificate(signer, certificateId, fingerprint);
    txId = committed.txId;
    issuedAt = committed.record.issuedAt;
  } catch (error) {
    const onChain = await getCertificate(certificateId).catch(() => null);
    if (!onChain || onChain.sha256 !== fingerprint) throw error;
    issuedAt = onChain.issuedAt;
  }
  await prisma.certificate.update({
    where: { id: certificateId },
    data: { status: "VALID", sha256: fingerprint, issuedAt: new Date(issuedAt), chainTxId: txId },
  });
  if (txId) {
    await prisma.blockchainTransaction.create({
      data: { functionName: "IssueCertificate", txId, certificateId, institutionId: institution.id, status: "CONFIRMED" },
    }).catch(() => undefined);
  }
  await writeAudit({
    actorUserId: issuer.userId,
    action: "certificate.issue",
    entityType: "certificate",
    entityId: certificateId,
    metadata: txId ? { demo: true, txId } : { demo: true },
  });
}
