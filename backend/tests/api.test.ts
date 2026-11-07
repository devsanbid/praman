import { randomBytes } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { prisma } from "../src/db";

const suffix = randomBytes(4).toString("hex");
const studentEmail = `student.${suffix}@praman.test`;
const password = "TestPassword1x";
let csrf = "";

const app = createApp(loadConfig());

function tokenFrom(response: request.Response, name: string): string {
  const cookies = response.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  const row = list.find((item) => item.startsWith(`${name}=`));
  if (!row) throw new Error(`missing ${name}`);
  return row.split(";")[0]?.slice(name.length + 1) ?? "";
}

beforeAll(async () => {
  await prisma.$connect();
});

describe("authentication and public checks", () => {
  it("registers a student and rejects an issuer role on the public form", async () => {
    const created = await request(app).post("/api/v1/auth/register").send({
      role: "STUDENT",
      fullName: "Sample Student (Praman demo)",
      email: studentEmail,
      password,
    });
    expect(created.status).toBe(201);
    csrf = tokenFrom(created, "praman_csrf");
    expect(created.body.data.user.role).toBe("STUDENT");

    const rejected = await request(app).post("/api/v1/auth/register").send({
      role: "INSTITUTION_ADMIN",
      fullName: "Not Allowed Person",
      email: `no.${suffix}@praman.test`,
      password,
    });
    expect(rejected.status).toBe(400);
  });

  it("requires the session and the CSRF header for later changes", async () => {
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", `praman_session=${tokenFrom(await request(app).post("/api/v1/auth/login").send({ email: studentEmail, password }), "praman_session")}`);
    expect(me.status).toBe(200);

    const agent = request.agent(app);
    const login = await agent.post("/api/v1/auth/login").send({ email: studentEmail, password });
    expect(login.status).toBe(200);
    csrf = tokenFrom(login, "praman_csrf");
    const blocked = await agent.post("/api/v1/auth/logout");
    expect(blocked.status).toBe(403);
    const signedOut = await agent.post("/api/v1/auth/logout").set("x-csrf-token", csrf);
    expect(signedOut.status).toBe(200);
  });

  it("keeps an institution applicant signed out until approval", async () => {
    const email = `issuer.${suffix}@praman.test`;
    const applied = await request(app).post("/api/v1/institutions/applications").send({
      name: `Sample College ${suffix} (Praman demo)`,
      type: "PLUS_TWO",
      registrationNumber: `REG-${suffix}`,
      addressLine: "Sample address",
      district: "Kathmandu",
      province: "Bagmati",
      phone: "9800000001",
      email: `office.${suffix}@praman.test`,
      representativeName: "Sample Registrar (Praman demo)",
      representativeTitle: "Registrar",
      representativeEmail: email,
      password,
    });
    expect(applied.status).toBe(201);
    const login = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(login.status).toBe(401);
  });

  it("rejects a student from the institution certificate list", async () => {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ email: studentEmail, password });
    const listed = await agent.get("/api/v1/certificates");
    expect(listed.status).toBe(403);
  });

  it("rejects active PDF content before any ledger call", async () => {
    const response = await request(app)
      .post("/api/v1/verify")
      .attach("document", Buffer.from("%PDF-1.7\n/JavaScript (alert)"), "bad.pdf");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_FILE");
  });

  it("keeps the audit log append-only", async () => {
    await expect(prisma.$executeRaw`UPDATE "AuditLog" SET action = action`).rejects.toThrow(/append-only/);
  });
});
