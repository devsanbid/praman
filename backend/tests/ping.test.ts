import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCsr, ecdsaLowS, fabricCaAuthToken, fabricCaTrustPem, pingPayloadOk } from "../src/fabric";

describe("ledger ping payload", () => {
  it("accepts the raw chaincode string and a JSON string", () => {
    expect(pingPayloadOk("ok")).toBe(true);
    expect(pingPayloadOk("ok\n")).toBe(true);
    expect(pingPayloadOk('"ok"')).toBe(true);
    expect(pingPayloadOk("")).toBe(false);
    expect(pingPayloadOk('{"ok":true}')).toBe(false);
  });
});

describe("Fabric CA trust bundle", () => {
  it("adds the issuer certificate that sits beside the TLS leaf", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "praman-ca-"));
    try {
      const leaf = path.join(dir, "tls-cert.pem");
      await writeFile(leaf, "LEAF");
      await writeFile(path.join(dir, "ca-cert.pem"), "ISSUER");
      const bundle = await fabricCaTrustPem(leaf);
      expect(bundle).toContain("ISSUER");
      expect(bundle).toContain("LEAF");
      expect(bundle.indexOf("ISSUER")).toBeLessThan(bundle.indexOf("LEAF"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Fabric CA registrar token", () => {
  it("signs the method, path, body, and certificate with a low-S ECDSA signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const cert = Buffer.from("-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
    const body = "{\"id\":\"iss-1\"}";
    const token = fabricCaAuthToken(cert, privateKey.export({ type: "pkcs8", format: "pem" }), "POST", "/register", body);
    const [encodedCert, encodedSig] = token.split(".");
    expect(encodedCert).toBe(cert.toString("base64"));
    const signature = ecdsaLowS(Buffer.from(encodedSig, "base64"), "prime256v1");
    const payload = `POST.${Buffer.from("/register").toString("base64")}.${Buffer.from(body).toString("base64")}.${encodedCert}`;
    const verifier = createVerify("SHA256");
    verifier.update(payload);
    verifier.end();
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });
});

describe("institution enrollment CSR", () => {
  it("builds a P-256 request that OpenSSL accepts", async () => {
    const { csrPem, privateKeyPem } = createCsr("iss-abcdef0123456789ab");
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    const dir = await mkdtemp(path.join(tmpdir(), "praman-csr-"));
    try {
      const csrPath = path.join(dir, "req.pem");
      await writeFile(csrPath, csrPem);
      const subject = execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-verify", "-subject"], { encoding: "utf8" });
      expect(subject).toContain("verify OK");
      expect(subject).toContain("iss-abcdef0123456789ab");
      const text = execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-text"], { encoding: "utf8" });
      expect(text).toContain("prime256v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
