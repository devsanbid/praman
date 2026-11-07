import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

function loadEnvFile(): void {
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../.env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

loadEnvFile();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_APP_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  DATABASE_URL: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_NAME: z.string().min(3),
  ADMIN_PASSWORD: z.string().min(12),
  UPLOAD_DIR: z.string().min(1),
  WALLET_DIR: z.string().min(1),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_242_880),
  FABRIC_PEER_ENDPOINT: z.string().min(1),
  FABRIC_PEER_HOST_ALIAS: z.string().min(1),
  FABRIC_CHANNEL: z.string().min(1),
  FABRIC_CHAINCODE: z.string().min(1),
  FABRIC_PLATFORM_MSP: z.string().min(1),
  FABRIC_ISSUER_MSP: z.string().min(1),
  FABRIC_TLS_CERT_PATH: z.string().min(1),
  FABRIC_PLATFORM_CERT_PATH: z.string().min(1),
  FABRIC_PLATFORM_KEY_PATH: z.string().min(1),
  FABRIC_VERIFIER_CERT_PATH: z.string().min(1),
  FABRIC_VERIFIER_KEY_PATH: z.string().min(1),
  FABRIC_CA_URL: z.string().url(),
  FABRIC_CA_NAME: z.string().min(1),
  FABRIC_CA_TLS_CERT_PATH: z.string().min(1),
  FABRIC_CA_REGISTRAR_CERT_PATH: z.string().min(1),
  FABRIC_CA_REGISTRAR_KEY_PATH: z.string().min(1),
  DEMO_PASSWORD: z.string().optional().default(""),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
