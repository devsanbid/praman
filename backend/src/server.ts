import { mkdir } from "node:fs/promises";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { hashPassword } from "./crypto";
import { prisma } from "./db";
import { ensureDemoAccounts } from "./demo";
import { initFabric, pingLedger } from "./fabric";
import { logger } from "./logger";

async function ensureAdmin(): Promise<void> {
  const config = loadConfig();
  const email = config.ADMIN_EMAIL.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;
  await prisma.user.create({
    data: {
      email,
      fullName: config.ADMIN_NAME,
      role: "SUPER_ADMIN",
      passwordHash: await hashPassword(config.ADMIN_PASSWORD),
    },
  });
  logger.info({ email }, "platform administrator created");
}

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  await mkdir(config.WALLET_DIR, { recursive: true });
  initFabric(config);
  await ensureAdmin();
  const chain = await pingLedger();
  if (!chain) logger.warn("fabric ledger is not reachable; issuance and verification will fail until it is");
  try {
    await ensureDemoAccounts(config, chain);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, "demo accounts were not prepared");
  }
  const app = createApp(config);
  app.listen(config.APP_PORT, () => {
    logger.info({ port: config.APP_PORT, chain }, "praman api listening");
  });
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : error }, "api failed to start");
  process.exit(1);
});
