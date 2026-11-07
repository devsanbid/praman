import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { connect, hash, Identity, signers, type Gateway } from "@hyperledger/fabric-gateway";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { logger } from "./logger";

export type ChainCertificate = {
  certificateId: string;
  sha256: string;
  issuerId: string;
  status: string;
  issuedAt: string;
  revokedAt?: string;
  revocationReason?: string;
};

export type ChainIssuer = {
  issuerId: string;
  institutionRef: string;
  enrollmentId: string;
  status: string;
  registeredAt: string;
};

export type VerifyOutcome = {
  result: "VALID" | "TAMPERED" | "REVOKED" | "NOT_FOUND" | "INVALID_ISSUER";
  certificateId?: string;
  sha256?: string;
  issuerId?: string;
  issuerStatus?: string;
  certificateStatus?: string;
  issuedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
};

type IdentityMaterial = {
  mspId: string;
  certPem: Buffer;
  keyPem: Buffer;
};

let grpcClient: grpc.Client | undefined;
let configRef: AppConfig | undefined;

export function initFabric(config: AppConfig): void {
  configRef = config;
  const tls = readFileSync(config.FABRIC_TLS_CERT_PATH);
  grpcClient = new grpc.Client(config.FABRIC_PEER_ENDPOINT, grpc.credentials.createSsl(tls), {
    "grpc.ssl_target_name_override": config.FABRIC_PEER_HOST_ALIAS,
    "grpc.default_authority": config.FABRIC_PEER_HOST_ALIAS,
  });
}



function requireConfig(): AppConfig {
  if (!configRef || !grpcClient) throw new Error("Fabric gateway is not initialised");
  return configRef;
}

async function materialFrom(certPath: string, keyPath: string, mspId: string): Promise<IdentityMaterial> {
  return {
    mspId,
    certPem: await readFile(certPath),
    keyPem: await readFile(keyPath),
  };
}

export async function platformAdminMaterial(): Promise<IdentityMaterial> {
  return platformAdmin();
}

async function platformAdmin(): Promise<IdentityMaterial> {
  const config = requireConfig();
  return materialFrom(config.FABRIC_PLATFORM_CERT_PATH, config.FABRIC_PLATFORM_KEY_PATH, config.FABRIC_PLATFORM_MSP);
}

async function verifierIdentity(): Promise<IdentityMaterial> {
  const config = requireConfig();
  return materialFrom(config.FABRIC_VERIFIER_CERT_PATH, config.FABRIC_VERIFIER_KEY_PATH, config.FABRIC_PLATFORM_MSP);
}

export async function issuerMaterial(certPath: string, keyPath: string): Promise<IdentityMaterial> {
  const config = requireConfig();
  return materialFrom(certPath, keyPath, config.FABRIC_ISSUER_MSP);
}

function gatewayFor(material: IdentityMaterial): Gateway {
  const identity: Identity = { mspId: material.mspId, credentials: material.certPem };
  const signer = signers.newPrivateKeySigner(createPrivateKey(material.keyPem));
  return connect({
    client: grpcClient!,
    identity,
    signer,
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 15_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 20_000 }),
    submitOptions: () => ({ deadline: Date.now() + 10_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 45_000 }),
  });
}

async function evaluateBytes(material: IdentityMaterial, fn: string, args: string[]): Promise<Buffer> {
  const gateway = gatewayFor(material);
  try {
    const contract = gateway.getNetwork(requireConfig().FABRIC_CHANNEL).getContract(requireConfig().FABRIC_CHAINCODE);
    const bytes = await contract.evaluateTransaction(fn, ...args);
    return Buffer.from(bytes);
  } catch (error) {
    throw mapChainError(error);
  } finally {
    gateway.close();
  }
}

async function evaluateJson<T>(material: IdentityMaterial, fn: string, args: string[]): Promise<T> {
  const bytes = await evaluateBytes(material, fn, args);
  return JSON.parse(bytes.toString("utf8")) as T;
}

/** Ping returns the raw chaincode string `ok`, not a JSON object. */
export function pingPayloadOk(raw: string): boolean {
  const value = raw.trim();
  return value === "ok" || value === '"ok"';
}

async function submitJson<T>(material: IdentityMaterial, fn: string, args: string[]): Promise<{ txId: string; payload: T }> {
  const gateway = gatewayFor(material);
  try {
    const contract = gateway.getNetwork(requireConfig().FABRIC_CHANNEL).getContract(requireConfig().FABRIC_CHAINCODE);
    const submitted = await contract.submitAsync(fn, { arguments: args });
    const status = await submitted.getStatus();
    if (!status.successful) {
      throw new ApiError(502, "CHAIN_COMMIT_FAILED", "The blockchain did not commit the transaction");
    }
    const payload = JSON.parse(Buffer.from(submitted.getResult()).toString("utf8")) as T;
    return { txId: submitted.getTransactionId(), payload };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw mapChainError(error);
  } finally {
    gateway.close();
  }
}

function chainErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: Array<{ message?: string }> }).details;
  if (!Array.isArray(details)) return message;
  const extra = details.map((detail) => detail.message).filter((item): item is string => Boolean(item));
  return extra.length > 0 ? `${message} | ${extra.join(" | ")}` : message;
}

function mapChainError(error: unknown): Error {
  const message = chainErrorText(error);
  const codes = ["INVALID_ARGUMENT", "FORBIDDEN", "ALREADY_EXISTS", "NOT_FOUND"] as const;
  for (const code of codes) {
    const index = message.indexOf(`${code}:`);
    if (index >= 0) {
      const detail = message.slice(index + code.length + 1).split("\n")[0]?.trim() || code;
      const status = code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : code === "ALREADY_EXISTS" ? 409 : 400;
      return new ApiError(status, code, detail);
    }
  }
  logger.error({ err: message }, "fabric call failed");
  return new ApiError(502, "CHAIN_ERROR", "The blockchain request could not be completed");
}

export async function pingLedger(): Promise<boolean> {
  try {
    const bytes = await evaluateBytes(await verifierIdentity(), "Ping", []);
    return pingPayloadOk(bytes.toString("utf8"));
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, "fabric ping failed");
    return false;
  }
}

export async function registerIssuer(issuerId: string, institutionRef: string, enrollmentId: string): Promise<string> {
  const { txId } = await submitJson(await platformAdmin(), "RegisterIssuer", [issuerId, institutionRef, enrollmentId]);
  return txId;
}

export async function setIssuerStatus(issuerId: string, active: boolean): Promise<string> {
  const fn = active ? "ReactivateIssuer" : "SuspendIssuer";
  const { txId } = await submitJson(await platformAdmin(), fn, [issuerId]);
  return txId;
}

export async function issueCertificate(material: IdentityMaterial, certificateId: string, sha256hex: string): Promise<{ txId: string; record: ChainCertificate }> {
  const { txId, payload } = await submitJson<ChainCertificate>(material, "IssueCertificate", [certificateId, sha256hex]);
  return { txId, record: payload };
}

export async function revokeCertificate(
  material: IdentityMaterial,
  certificateId: string,
  reason: string,
): Promise<{ txId: string; record: ChainCertificate }> {
  const { txId, payload } = await submitJson<ChainCertificate>(material, "RevokeCertificate", [certificateId, reason]);
  return { txId, record: payload };
}

export async function getCertificate(certificateId: string): Promise<ChainCertificate> {
  return evaluateJson<ChainCertificate>(await verifierIdentity(), "GetCertificate", [certificateId]);
}

export async function getCertificateByHash(sha256hex: string): Promise<ChainCertificate> {
  return evaluateJson<ChainCertificate>(await verifierIdentity(), "GetCertificateByHash", [sha256hex]);
}

export type ChainHistoryEntry = {
  txId: string;
  timestamp: string;
  isDelete: boolean;
  record?: ChainCertificate;
};

export async function getCertificateHistory(certificateId: string): Promise<ChainHistoryEntry[]> {
  return evaluateJson<ChainHistoryEntry[]>(await verifierIdentity(), "GetCertificateHistory", [certificateId]);
}

export async function verifyCertificate(certificateId: string, sha256hex: string): Promise<VerifyOutcome> {
  return evaluateJson<VerifyOutcome>(await verifierIdentity(), "VerifyCertificate", [certificateId, sha256hex]);
}

export async function getIssuer(issuerId: string): Promise<ChainIssuer> {
  return evaluateJson<ChainIssuer>(await verifierIdentity(), "GetIssuer", [issuerId]);
}

type CaResponse = { success?: boolean; errors?: Array<{ message?: string }>; result?: { Cert?: string; secret?: string } };

function caRequest(url: string, body: string, headers: Record<string, string>, caPem: string): Promise<CaResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        ca: caPem,
        servername: target.hostname,
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new ApiError(502, "CA_ERROR", `Fabric CA returned ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as CaResponse);
          } catch {
            reject(new ApiError(502, "CA_ERROR", "Fabric CA returned a response that was not JSON"));
          }
        });
      },
    );
    req.on("error", (error) => reject(new ApiError(502, "CA_ERROR", `Fabric CA is unreachable: ${error.message}`)));
    req.write(body);
    req.end();
  });
}

const CURVE_ORDER: Record<string, bigint> = {
  prime256v1: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
  secp384r1: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973"),
};

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function readDerInteger(signature: Buffer, offset: number): { value: bigint; next: number } {
  if (signature[offset] !== 0x02) throw new Error("ECDSA signature is not DER");
  const length = signature[offset + 1];
  const start = offset + 2;
  const bytes = signature.subarray(start, start + length);
  return { value: BigInt(`0x${bytes.toString("hex")}`), next: start + length };
}

/** Fabric CA rejects ECDSA signatures whose S is greater than half the curve order. */
export function ecdsaLowS(signature: Buffer, curve: string): Buffer {
  const order = CURVE_ORDER[curve];
  if (!order) throw new Error(`Unsupported registrar curve ${curve}`);
  if (signature[0] !== 0x30) throw new Error("ECDSA signature is not DER");
  const r = readDerInteger(signature, 2);
  const s = readDerInteger(signature, r.next);
  const low = s.value > order / 2n ? order - s.value : s.value;
  const body = Buffer.concat([derInteger(r.value), derInteger(low)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Fabric CA authorization token: base64(cert) + "." + base64(ECDSA-SHA256).
 * The signed payload is METHOD.base64(uri).base64(body).base64(cert).
 */
export function fabricCaAuthToken(certPem: Buffer, keyPem: Buffer, method: string, uri: string, body: string): string {
  const cert = certPem.toString("base64");
  const payload = `${method}.${Buffer.from(uri).toString("base64")}.${Buffer.from(body).toString("base64")}.${cert}`;
  const key = createPrivateKey(keyPem);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || !curve) {
    throw new ApiError(500, "CA_ERROR", "The Fabric CA registrar key must be an ECDSA key");
  }
  const signer = createSign("SHA256");
  signer.update(payload);
  signer.end();
  const signature = ecdsaLowS(signer.sign(key), curve);
  return `${cert}.${signature.toString("base64")}`;
}

function derTag(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  if (content.length < 0x100) return Buffer.concat([Buffer.from([tag, 0x81, content.length]), content]);
  return Buffer.concat([Buffer.from([tag, 0x82, (content.length >> 8) & 0xff, content.length & 0xff]), content]);
}

function derSeq(parts: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(parts));
}

function pemEncode(label: string, derBytes: Buffer): string {
  const body = derBytes.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** P-256 CSR. The Fabric gateway signer rejects RSA identities. */
export function createCsr(commonName: string): { privateKeyPem: string; csrPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const commonNameValue = derSeq([
    derTag(0x06, Buffer.from("550403", "hex")),
    derTag(0x0c, Buffer.from(commonName, "utf8")),
  ]);
  const info = derSeq([
    derTag(0x02, Buffer.from([0x00])),
    derSeq([derTag(0x31, commonNameValue)]),
    spki,
    derTag(0xa0, Buffer.alloc(0)),
  ]);
  const signer = createSign("SHA256");
  signer.update(info);
  signer.end();
  const signature = ecdsaLowS(signer.sign(privateKey), "prime256v1");
  const csr = derSeq([
    info,
    derSeq([derTag(0x06, Buffer.from("2a8648ce3d040302", "hex"))]),
    derTag(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  ]);
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  const privateKeyPem = typeof exported === "string" ? exported : exported.toString("utf8");
  return {
    privateKeyPem: privateKeyPem.endsWith("\n") ? privateKeyPem : `${privateKeyPem}\n`,
    csrPem: pemEncode("CERTIFICATE REQUEST", csr),
  };
}

function decodeCert(value: string): string {
  if (value.includes("BEGIN CERTIFICATE")) return value.endsWith("\n") ? value : `${value}\n`;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
  return `-----BEGIN CERTIFICATE-----\n${value.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Node trusts CA certificates, not a TLS leaf. Fabric CA's tls-cert.pem is the
 * leaf signed by ca-cert.pem in the same directory. Include the issuer when it
 * is present so enrollment can verify the CA server.
 */
export async function fabricCaTrustPem(configuredPath: string): Promise<string> {
  const configured = (await readFile(configuredPath)).toString("utf8").trim();
  const issuerPath = path.join(path.dirname(configuredPath), "ca-cert.pem");
  try {
    const issuer = (await readFile(issuerPath)).toString("utf8").trim();
    if (configured.includes(issuer)) return `${configured}\n`;
    return `${issuer}\n${configured}\n`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${configured}\n`;
    throw error;
  }
}

export async function enrollInstitution(issuerId: string): Promise<{ enrollmentId: string; certPath: string; keyPath: string }> {
  const config = requireConfig();
  const enrollmentId = issuerId;
  const secret = randomBytes(24).toString("hex");
  const caPem = await fabricCaTrustPem(config.FABRIC_CA_TLS_CERT_PATH);
  const registrarCert = await readFile(config.FABRIC_CA_REGISTRAR_CERT_PATH);
  const registrarKey = await readFile(config.FABRIC_CA_REGISTRAR_KEY_PATH);

  const registerBody = JSON.stringify({
    id: enrollmentId,
    type: "client",
    affiliation: "org1",
    max_enrollments: -1,
    secret,
    caname: config.FABRIC_CA_NAME,
    attrs: [
      { name: "cert.role", value: "issuer", ecert: true },
      { name: "cert.issuerId", value: issuerId, ecert: true },
    ],
  });
  const registerUrl = new URL(`${config.FABRIC_CA_URL}/register`);
  const token = fabricCaAuthToken(registrarCert, registrarKey, "POST", `${registerUrl.pathname}${registerUrl.search}`, registerBody);
  await caRequest(registerUrl.toString(), registerBody, { Authorization: token }, caPem);

  const { privateKeyPem, csrPem } = createCsr(enrollmentId);
  const enrollBody = JSON.stringify({
    certificate_request: csrPem,
    profile: "",
    label: "",
    CAName: config.FABRIC_CA_NAME,
    attr_reqs: [
      { name: "cert.role", optional: false },
      { name: "cert.issuerId", optional: false },
    ],
  });
  const basic = Buffer.from(`${enrollmentId}:${secret}`).toString("base64");
  const enrolled = await caRequest(`${config.FABRIC_CA_URL}/enroll`, enrollBody, { Authorization: `Basic ${basic}` }, caPem);
  const cert = enrolled.result?.Cert;
  if (!cert) throw new ApiError(502, "CA_ERROR", "Fabric CA did not return an enrollment certificate");

  const dir = path.join(config.WALLET_DIR, "issuers", issuerId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  await writeFile(certPath, decodeCert(cert), { mode: 0o600 });
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  return { enrollmentId, certPath, keyPath };
}
