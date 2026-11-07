#!/usr/bin/env node
// Measures a real issue, tamper, revoke, and verification loop.
// Exits without inventing numbers when the API or ledger is unavailable.
import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.EVAL_BASE ?? "http://127.0.0.1:4000";
const samples = Number(process.env.EVAL_SAMPLES ?? 15);
const reportPath = path.resolve("reports/verification-latency.json");

const jar = new Map();

function store(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const row of list) {
    const [pair] = row.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function call(method, urlPath, { json, form, raw } = {}) {
  const headers = { cookie: cookieHeader() };
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  } else if (raw !== undefined) {
    body = raw;
  }
  if (method !== "GET" && jar.has("praman_csrf")) headers["x-csrf-token"] = jar.get("praman_csrf");
  const started = performance.now();
  const response = await fetch(`${base}${urlPath}`, { method, headers, body });
  store(response);
  const elapsed = performance.now() - started;
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, payload, elapsed };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summary(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    medianMs: Number(percentile(values, 50).toFixed(2)),
    averageMs: Number((total / values.length).toFixed(2)),
    p95Ms: Number(percentile(values, 95).toFixed(2)),
  };
}

async function fail(message) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ status: "failed", error: message, measuredAt: new Date().toISOString() }, null, 2)}\n`);
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    await fail("ADMIN_EMAIL and ADMIN_PASSWORD must already be in the environment");
  }
  let health;
  try {
    health = await call("GET", "/api/v1/health");
  } catch (error) {
    await fail(`API is not reachable at ${base}: ${error instanceof Error ? error.message : error}`);
  }
  if (!health.payload?.data?.chainReachable) {
    await fail("The API is up and the Fabric ledger is not reachable. No latency numbers were invented.");
  }

  const admin = await call("POST", "/api/v1/auth/login", {
    json: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  if (admin.status !== 200) await fail(`Administrator login failed with HTTP ${admin.status}`);

  const stamp = Date.now();
  const issuerEmail = `eval-admin-${stamp}@praman.demo`;
  const applied = await call("POST", "/api/v1/institutions/applications", {
    json: {
      name: "Sample SEE Board (Praman demo)",
      type: "SEE_BOARD",
      registrationNumber: `EVAL-${stamp}`,
      addressLine: "Sample address, demonstration only",
      district: "Kathmandu",
      province: "Bagmati",
      phone: "9800000099",
      email: `eval-office-${stamp}@praman.demo`,
      representativeName: "Sample SEE Registrar (Praman demo)",
      representativeTitle: "Registrar",
      representativeEmail: issuerEmail,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  if (applied.status !== 201) await fail(`Institution application failed with HTTP ${applied.status}`);
  const approved = await call("POST", `/api/v1/admin/institutions/${applied.payload.data.id}/approve`, { json: {} });
  if (approved.status !== 200) await fail(`Institution approval failed with HTTP ${approved.status}: ${approved.payload?.error?.message ?? ""}`);

  jar.clear();
  const issuerLogin = await call("POST", "/api/v1/auth/login", {
    json: { email: issuerEmail, password: process.env.ADMIN_PASSWORD },
  });
  if (issuerLogin.status !== 200) await fail(`Institution login failed with HTTP ${issuerLogin.status}`);
  if (issuerLogin.payload?.data?.user?.mustChangePassword) {
    const nextPassword = `Eval${randomBytes(12).toString("hex")}9a`;
    const changed = await call("POST", "/api/v1/auth/change-password", {
      json: { currentPassword: process.env.ADMIN_PASSWORD, newPassword: nextPassword },
    });
    if (changed.status !== 200) {
      await fail(`Password change failed with HTTP ${changed.status}: ${changed.payload?.error?.message ?? ""}`);
    }
  }

  const issue = await call("POST", "/api/v1/certificates", {
    form: (() => {
      const form = new FormData();
      form.set("type", "SEE");
      form.set("fullName", "Sample Holder (Praman demo)");
      form.set("dateOfBirth", "2008-04-12");
      form.set("holderEmail", "student@praman.demo");
      form.set("symbolOrRegNo", "EVAL2082001");
      form.set("programName", "Secondary Education Examination");
      form.set("academicYearBs", "2082");
      form.set("academicYearAd", "2025");
      form.set("gpaOrDivision", "3.45");
      form.set("streamOrFaculty", "General");
      form.set("campusOrSchool", "Sample Campus (Praman demo)");
      form.set("issueDate", "2025-07-01");
      form.set("consent", "true");
      form.set("documentSource", "generate");
      return form;
    })(),
  });
  if (issue.status !== 201) await fail(`Issuance failed with HTTP ${issue.status}: ${issue.payload?.error?.message ?? ""}`);
  const certificateId = issue.payload.data.id;

  const document = await fetch(`${base}/api/v1/certificates/${certificateId}/document`, { headers: { cookie: cookieHeader() } });
  if (!document.ok) await fail(`Certificate download failed with HTTP ${document.status}`);
  const original = Buffer.from(await document.arrayBuffer());
  const tampered = Buffer.from(original);
  tampered[Math.min(800, tampered.length - 1)] ^= 0x01;

  async function verify(bytes, id = certificateId) {
    const form = new FormData();
    form.set("document", new Blob([bytes], { type: "application/pdf" }), "certificate.pdf");
    if (id) form.set("certificateId", id);
    return call("POST", "/api/v1/verify", { form });
  }

  const valid = await verify(original);
  const tamper = await verify(tampered);
  const missing = await call("GET", "/api/v1/verify/NPL-SEE-2082-0000000000");
  const revoked = await call("POST", `/api/v1/certificates/${certificateId}/revoke`, { json: { reason: "Evaluation revocation for the prototype" } });
  const afterRevoke = await verify(original);

  const uploadTimes = [];
  const statusTimes = [];
  for (let index = 0; index < samples; index += 1) {
    const uploaded = await verify(original);
    uploadTimes.push(uploaded.elapsed);
    const status = await call("GET", `/api/v1/verify/${certificateId}`);
    statusTimes.push(status.elapsed);
  }

  const decisions = {
    valid: valid.payload?.data?.result ?? null,
    tampered: tamper.payload?.data?.result ?? null,
    notFound: missing.payload?.data?.result ?? null,
    revokeHttp: revoked.status,
    revoked: afterRevoke.payload?.data?.result ?? null,
  };
  const expected = decisions.valid === "VALID" && decisions.tampered === "TAMPERED" && decisions.notFound === "NOT_FOUND" && decisions.revokeHttp === 200 && decisions.revoked === "REVOKED";
  const report = {
    status: expected ? "completed" : "completed_with_unexpected_results",
    measuredAt: new Date().toISOString(),
    base,
    certificateId,
    chainTxId: issue.payload.data.chainTxId ?? null,
    issuanceHttpMs: Number(issue.elapsed.toFixed(2)),
    decisions,
    uploadVerification: summary(uploadTimes),
    statusLookup: summary(statusTimes),
    notes: [
      "Times are client-observed HTTP durations against the running API, including ledger evaluation.",
      "A VALID result means the file fingerprint matches. It does not prove the presenter's legal identity.",
      "The median target in the proposal is under five seconds for verification.",
    ],
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, decisions, uploadVerification: report.uploadVerification, statusLookup: report.statusLookup }));
  if (!expected) process.exit(1);
}

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error));
});
