import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { sha256, stableStringify } from "./crypto";

const LOCK_KEY = 842104;

export type AuditInput = {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function writeAudit(entry: AuditInput, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<void> {
  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const previous = await tx.auditLog.findFirst({ orderBy: { createdAt: "desc" } });
    const prevHash = previous?.entryHash ?? "GENESIS";
    const createdAt = new Date();
    const body = {
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      createdAt: createdAt.toISOString(),
      entityId: entry.entityId ?? null,
      entityType: entry.entityType,
      metadata: entry.metadata ?? {},
      prevHash,
    };
    const entryHash = sha256(`${prevHash}\n${stableStringify(body)}`);
    await tx.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ?? {},
        prevHash,
        entryHash,
        createdAt,
      },
    });
  };

  if (db === prisma) {
    await prisma.$transaction(run);
    return;
  }
  await run(db);
}

export async function verifyAuditChain(): Promise<{ ok: boolean; count: number; brokenAt?: string }> {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  let prev = "GENESIS";
  for (const row of rows) {
    if (row.prevHash !== prev) return { ok: false, count: rows.length, brokenAt: row.id };
    const body = {
      action: row.action,
      actorUserId: row.actorUserId,
      createdAt: row.createdAt.toISOString(),
      entityId: row.entityId,
      entityType: row.entityType,
      metadata: row.metadata ?? {},
      prevHash: row.prevHash,
    };
    const expected = sha256(`${prev}\n${stableStringify(body)}`);
    if (expected !== row.entryHash) return { ok: false, count: rows.length, brokenAt: row.id };
    prev = row.entryHash;
  }
  return { ok: true, count: rows.length };
}
