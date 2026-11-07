import { loadConfig } from "./config";
import { ensureDemoAccounts } from "./demo";
import { prisma } from "./db";
import { initFabric, pingLedger } from "./fabric";
import { logger } from "./logger";

async function main(): Promise<void> {
  const config = loadConfig();
  initFabric(config);
  const chain = await pingLedger();
  await ensureDemoAccounts(config, chain);
  if (!chain) logger.warn("demo institutions stay pending until the ledger is reachable");
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error instanceof Error ? error.message : error }, "seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
