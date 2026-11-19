import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, downloadFile } from "../api";
import { useAuth } from "../auth";
import { Alert, Button, Empty, Field, Modal, Shell, StatusPill, controlClass } from "../ui";

type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

type CountMap = Record<string, number>;

type AdminStats = {
  institutions: CountMap;
  certificates: CountMap;
  verificationsLast24h: CountMap;
  chainReachable: boolean;
};

const institutionCounts: [string, string][] = [
  ["APPROVED", "Approved"],
  ["PENDING", "Pending"],
  ["SUSPENDED", "Suspended"],
  ["REJECTED", "Rejected"],
];

const certificateCounts: [string, string][] = [
  ["VALID", "Valid"],
  ["REVOKED", "Revoked"],
  ["PENDING_CHAIN", "Waiting for the ledger"],
  ["ISSUANCE_FAILED", "Issuance failed"],
];

const verificationCounts: [string, string][] = [
  ["VALID", "Valid"],
  ["TAMPERED", "Tampered"],
  ["REVOKED", "Revoked"],
  ["NOT_FOUND", "Not found"],
  ["INVALID_ISSUER", "Invalid issuer"],
  ["ERROR", "Error"],
];

export function AdminHome() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<AdminStats>("/api/v1/admin/stats").then(setStats).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load stats"));
  }, []);
  const institutions = countRows(stats?.institutions, institutionCounts);
  const certificates = countRows(stats?.certificates, certificateCounts);
  const verifications = countRows(stats?.verificationsLast24h, verificationCounts);
  return (
    <Shell title="Platform overview">
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {!stats ? <p className="text-sm">Loading…</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          <CountCard title="Institutions" rows={institutions} />
          <CountCard title="Certificates" rows={certificates} />
          <CountCard title="Verifications, last 24 hours" rows={verifications} hideZero empty="No checks in the last 24 hours" />
          <Card title="Ledger">
            <p className="mt-2 font-serif text-3xl">{stats.chainReachable ? "Reachable" : "Not reachable"}</p>
          </Card>
        </div>
      )}
    </Shell>
  );
}

type Institution = {
  id: string;
  name: string;
  type: string;
  status: string;
  registrationNumber: string;
  province: string;
  email: string;
};

export function AdminInstitutions() {
  const [rows, setRows] = useState<Institution[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Institution | null>(null);
  const [mode, setMode] = useState<"approve" | "reject" | "suspend" | "reactivate" | null>(null);
  const [reason, setReason] = useState("Application does not match the submitted registration details");
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api<Page<Institution>>("/api/v1/admin/institutions?pageSize=50");
    setRows(data.items);
  }
  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load institutions"));
  }, []);

  async function run() {
    if (!pending || !mode) return;
    setBusy(true);
    setError("");
    try {
      const path = `/api/v1/admin/institutions/${pending.id}/${mode}`;
      await api(path, { method: "POST", body: mode === "reject" ? JSON.stringify({ reason }) : "{}" });
      setPending(null);
      setMode(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Institutions">
      {error ? <div className="mb-3"><Alert tone="bad">{error}</Alert></div> : null}
      {rows.length === 0 ? <Empty title="No institutions yet" body="Applications appear here before they can issue certificates." /> : (
        <div className="overflow-auto rounded-lg border border-line bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink/60"><tr><th className="p-3">Name</th><th>Type</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line/70">
                  <td className="p-3"><div className="font-medium">{row.name}</div><div className="text-xs text-ink/50">{row.registrationNumber} · {row.province}</div></td>
                  <td>{row.type}</td>
                  <td><StatusPill value={row.status} /></td>
                  <td className="space-x-2 p-3 text-right">
                    {row.status === "PENDING" || row.status === "REJECTED" ? <Button onClick={() => { setPending(row); setMode("approve"); }}>Approve</Button> : null}
                    {row.status === "PENDING" ? <Button tone="ghost" onClick={() => { setPending(row); setMode("reject"); }}>Reject</Button> : null}
                    {row.status === "APPROVED" ? <Button tone="danger" onClick={() => { setPending(row); setMode("suspend"); }}>Suspend</Button> : null}
                    {row.status === "SUSPENDED" ? <Button onClick={() => { setPending(row); setMode("reactivate"); }}>Reactivate</Button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pending && mode ? (
        <Modal
          title={`${mode} ${pending.name}`}
          body={mode === "approve" ? "Approval enrols a Fabric identity and commits RegisterIssuer. It fails if the ledger is down." : "This changes whether the institution can write new certificates. Existing fingerprints stay on the ledger."}
          confirm={mode}
          busy={busy}
          danger={mode === "reject" || mode === "suspend"}
          onConfirm={() => void run()}
          onClose={() => { setPending(null); setMode(null); }}
        />
      ) : null}
      {mode === "reject" ? (
        <div className="fixed bottom-4 left-1/2 z-30 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-md bg-card p-3 shadow">
          <Field label="Rejection reason">
            <input className={controlClass} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
      ) : null}
    </Shell>
  );
}

type UserRow = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  membership: { institution: { name: string } } | null;
};

export function AdminUsers() {
  const { user } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api<Page<UserRow>>("/api/v1/admin/users?pageSize=50");
    setRows(data.items);
  }
  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load users")); }, []);

  async function toggle() {
    if (!target) return;
    setBusy(true);
    try {
      await api(`/api/v1/admin/users/${target.id}`, { method: "POST", body: JSON.stringify({ isActive: !target.isActive }) });
      setTarget(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Users">
      {error ? <div className="mb-3"><Alert tone="bad">{error}</Alert></div> : null}
      <div className="overflow-auto rounded-lg border border-line bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-ink/60"><tr><th className="p-3">Person</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line/70">
                <td className="p-3"><div>{row.fullName}</div><div className="text-xs text-ink/50">{row.email}</div></td>
                <td>{row.role}{row.membership ? ` · ${row.membership.institution.name}` : ""}</td>
                <td>{row.isActive ? "Active" : "Inactive"}</td>
                <td className="p-3 text-right">{row.id === user?.id ? null : <Button tone="ghost" onClick={() => setTarget(row)}>{row.isActive ? "Deactivate" : "Activate"}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {target ? (
        <Modal title={target.isActive ? "Deactivate account" : "Activate account"} body={`${target.fullName} will ${target.isActive ? "lose" : "regain"} access.`} confirm="Confirm" busy={busy} danger={target.isActive} onConfirm={() => void toggle()} onClose={() => setTarget(null)} />
      ) : null}
    </Shell>
  );
}

type AuditRow = { id: string; action: string; entityType: string; entityId: string | null; createdAt: string; entryHash: string; actor: { role: string } | null };

export function AdminAudit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [check, setCheck] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Page<AuditRow>>("/api/v1/admin/audit?pageSize=50").then((data) => setRows(data.items)).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load the audit log"));
  }, []);
  return (
    <Shell title="Audit log">
      <div className="mb-3 flex items-center gap-3">
        <Button tone="ghost" onClick={() => void api<{ ok: boolean; count: number }>("/api/v1/admin/audit/verify").then((data) => setCheck(data.ok ? `Hash chain intact (${data.count} entries)` : "Hash chain is broken")).catch(() => setCheck("The chain could not be checked"))}>Check hash chain</Button>
        {check ? <span className="text-sm">{check}</span> : null}
      </div>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {rows.length === 0 ? <Empty title="No audit entries" body="Sign-ins, approvals, issuance, verification, and revocation are recorded here." /> : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card">
          {rows.map((row) => (
            <li key={row.id} className="px-3 py-2 text-sm">
              <div className="flex justify-between gap-3"><span className="font-medium">{row.action}</span><time className="text-ink/50">{new Date(row.createdAt).toLocaleString()}</time></div>
              <div className="text-xs text-ink/50">{row.entityType} {row.entityId ?? ""} · {row.actor?.role ?? "anonymous"} · {row.entryHash.slice(0, 12)}</div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function AdminSettings() {
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ publicNotice: string }>("/api/v1/admin/settings").then((data) => setNotice(data.publicNotice)).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load settings"));
  }, []);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({ publicNotice: notice }) });
      setMessage("Notice saved");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Save failed");
    }
  }
  return (
    <Shell title="Settings">
      <form className="max-w-xl space-y-3" onSubmit={onSubmit}>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        {message ? <Alert tone="good">{message}</Alert> : null}
        <Field label="Public notice">
          <textarea className={controlClass} rows={4} maxLength={500} value={notice} onChange={(event) => setNotice(event.target.value)} />
        </Field>
        <Button type="submit">Save notice</Button>
      </form>
    </Shell>
  );
}

type InstitutionProfile = { name: string; status: string; type: string; registrationNumber: string; fabricIssuerId: string | null; province: string; district: string };

export function InstitutionHome() {
  const [profile, setProfile] = useState<InstitutionProfile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<InstitutionProfile>("/api/v1/institutions/me").then(setProfile).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "No institution profile"));
  }, []);
  return (
    <Shell title="Institution">
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {!profile ? <p className="text-sm">Loading…</p> : (
        <div className="max-w-xl rounded-lg border border-line bg-card p-4">
          <div className="flex items-center justify-between"><h2 className="font-serif text-2xl">{profile.name}</h2><StatusPill value={profile.status} /></div>
          <p className="mt-2 text-sm text-ink/70">{profile.type} · {profile.registrationNumber} · {profile.district}, {profile.province}</p>
          <p className="mt-2 text-sm">Blockchain issuer: {profile.fabricIssuerId ?? "Not enrolled yet"}</p>
          {profile.status !== "APPROVED" ? <div className="mt-3"><Alert>Issuance stays closed until the institution is approved.</Alert></div> : null}
        </div>
      )}
    </Shell>
  );
}

export function IssuePage() {
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ id: string; verificationUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("generate");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    form.set("documentSource", source);
    form.set("consent", form.get("consent") === "on" ? "true" : "false");
    try {
      const saved = await api<{ id: string; verificationUrl: string }>("/api/v1/certificates", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: form,
      });
      setDone(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Issuance failed");
    } finally {
      setBusy(false);
    }
  }

  if (!user?.canIssue) {
    return <Shell title="Issue a certificate"><Alert>Your account cannot issue certificates.</Alert></Shell>;
  }

  return (
    <Shell title="Issue a certificate">
      {done ? (
        <Alert tone="good">
          Issued {done.id}. The ledger commit completed. <Link className="underline" to={`/institution/certificates/${done.id}`}>Open the record</Link>
        </Alert>
      ) : (
        <form className="grid max-w-3xl gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
          {error ? <div className="sm:col-span-2"><Alert tone="bad">{error}</Alert></div> : null}
          <Field label="Certificate type">
            <select className={controlClass} name="type" defaultValue="SEE">
              <option value="SEE">SEE</option>
              <option value="PLUS_TWO">Higher secondary (+2)</option>
              <option value="UNIVERSITY">University</option>
            </select>
          </Field>
          <Field label="Document">
            <select className={controlClass} value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="generate">Generate a prototype PDF</option>
              <option value="upload">Upload an existing PDF</option>
            </select>
          </Field>
          <Field label="Holder name"><input className={controlClass} name="fullName" required /></Field>
          <Field label="Date of birth"><input className={controlClass} name="dateOfBirth" type="date" required /></Field>
          <Field label="Holder email"><input className={controlClass} name="holderEmail" type="email" /></Field>
          <Field label="Symbol or registration number"><input className={controlClass} name="symbolOrRegNo" required /></Field>
          <Field label="Programme"><input className={controlClass} name="programName" required /></Field>
          <Field label="Stream or faculty"><input className={controlClass} name="streamOrFaculty" /></Field>
          <Field label="Campus or school"><input className={controlClass} name="campusOrSchool" required /></Field>
          <Field label="GPA or division"><input className={controlClass} name="gpaOrDivision" required /></Field>
          <Field label="Academic year (BS)"><input className={controlClass} name="academicYearBs" required pattern="\d{4}" placeholder="2082" /></Field>
          <Field label="Academic year (AD)"><input className={controlClass} name="academicYearAd" type="number" required defaultValue={2025} /></Field>
          <Field label="Issue date"><input className={controlClass} name="issueDate" type="date" required /></Field>
          {source === "upload" ? <div className="sm:col-span-2"><Field label="PDF"><input className={controlClass} name="document" type="file" accept="application/pdf,.pdf" required /></Field></div> : null}
          <label className="sm:col-span-2 flex items-start gap-2 text-sm">
            <input name="consent" type="checkbox" required className="mt-1" />
            The holder was informed that a fingerprint of this document will be recorded on the permissioned ledger.
          </label>
          <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? "Waiting for the ledger…" : "Issue and record fingerprint"}</Button></div>
        </form>
      )}
    </Shell>
  );
}

type CertificateRow = {
  id: string;
  type: string;
  status: string;
  programName: string;
  symbolOrRegNo: string;
  student: { fullName: string };
  institution: { name: string };
};

export function CertificateList() {
  const [rows, setRows] = useState<CertificateRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Page<CertificateRow>>("/api/v1/certificates?pageSize=50").then((data) => setRows(data.items)).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load certificates"));
  }, []);
  return (
    <Shell title="Issued certificates">
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {rows.length === 0 ? <Empty title="Nothing issued yet" body="A certificate appears here only after the blockchain transaction commits." /> : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
              <div>
                <Link className="font-medium text-pine" to={`/institution/certificates/${row.id}`}>{row.student.fullName}</Link>
                <div className="text-xs text-ink/50">{row.id} · {row.programName} · {row.symbolOrRegNo}</div>
              </div>
              <StatusPill value={row.status} />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function CertificateDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [history, setHistory] = useState<Array<{ txId: string; timestamp: string; status: string | null }>>([]);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [certificate, chain] = await Promise.all([
      api<Record<string, unknown>>(`/api/v1/certificates/${id}`),
      api<Array<{ txId: string; timestamp: string; status: string | null }>>(`/api/v1/certificates/${id}/history`).catch(() => []),
    ]);
    setRow(certificate);
    setHistory(chain);
  }
  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load the certificate")); }, [id]);

  async function revoke() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/v1/certificates/${id}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
      setConfirm(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Revocation failed");
    } finally {
      setBusy(false);
    }
  }

  const status = String(row?.status ?? "");
  return (
    <Shell title="Certificate">
      {error ? <div className="mb-3"><Alert tone="bad">{error}</Alert></div> : null}
      {!row ? <p className="text-sm">Loading…</p> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
          <div className="rounded-lg border border-line bg-card p-4 text-sm">
            <div className="flex items-center justify-between"><h2 className="font-serif text-2xl">{id}</h2><StatusPill value={status} /></div>
            <p className="mt-2">Holder: {String((row.student as { fullName?: string } | undefined)?.fullName ?? "")}</p>
            <p>Programme: {String(row.programName ?? "")}</p>
            <p>Symbol: {String(row.symbolOrRegNo ?? "")}</p>
            <p>Fingerprint: <span className="break-all font-mono text-xs">{String(row.sha256 ?? "")}</span></p>
            <p>Transaction: {String(row.chainTxId ?? "pending")}</p>
            <div className="mt-4 flex gap-2">
              <Button tone="ghost" onClick={() => void downloadFile(`/api/v1/certificates/${id}/document`, `${id}.pdf`)}>Download PDF</Button>
              {user?.canRevoke && status === "VALID" ? <Button tone="danger" onClick={() => setConfirm(true)}>Revoke</Button> : null}
            </div>
            {confirm ? (
              <div className="mt-4 space-y-2">
                <Field label="Revocation reason"><input className={controlClass} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
              </div>
            ) : null}
            <h3 className="mt-6 font-serif text-xl">Ledger history</h3>
            {history.length === 0 ? <p className="text-ink/60">No history returned.</p> : (
              <ul className="mt-2 space-y-1">
                {history.map((entry) => <li key={entry.txId}>{entry.timestamp} · {entry.status} · <span className="font-mono text-xs">{entry.txId.slice(0, 16)}</span></li>)}
              </ul>
            )}
          </div>
          <img alt="Verification QR code" className="w-full rounded-lg border border-line bg-white" src={`/api/v1/certificates/${id}/qr`} />
        </div>
      )}
      {confirm ? <Modal title="Revoke this certificate" body="Revocation is recorded on the ledger. The original issuance stays in the history, and later checks fail." confirm="Revoke" danger busy={busy} onConfirm={() => void revoke()} onClose={() => setConfirm(false)} /> : null}
    </Shell>
  );
}

type Staff = { id: string; jobTitle: string; canIssue: boolean; canRevoke: boolean; user: { id: string; fullName: string; email: string; role: string; isActive: boolean } };

export function StaffPage() {
  const [rows, setRows] = useState<Staff[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setRows(await api<Staff[]>("/api/v1/institutions/staff"));
  }
  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load staff")); }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/institutions/staff", {
        method: "POST",
        body: JSON.stringify({
          fullName: form.get("fullName"),
          email: form.get("email"),
          password: form.get("password"),
          jobTitle: form.get("jobTitle"),
          canIssue: form.get("canIssue") === "on",
          canRevoke: form.get("canRevoke") === "on",
        }),
      });
      event.currentTarget.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add staff");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Staff">
      {error ? <div className="mb-3"><Alert tone="bad">{error}</Alert></div> : null}
      <form className="mb-6 grid max-w-3xl gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
        <Field label="Name"><input className={controlClass} name="fullName" required /></Field>
        <Field label="Email"><input className={controlClass} name="email" type="email" required /></Field>
        <Field label="Temporary password"><input className={controlClass} name="password" type="password" required minLength={12} /></Field>
        <Field label="Job title"><input className={controlClass} name="jobTitle" required /></Field>
        <label className="text-sm"><input name="canIssue" type="checkbox" /> Can issue</label>
        <label className="text-sm"><input name="canRevoke" type="checkbox" /> Can revoke</label>
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Add staff"}</Button></div>
      </form>
      {rows.length === 0 ? <Empty title="No staff listed" body="The institution administrator is included after the profile loads." /> : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <div>{row.user.fullName} · {row.jobTitle}</div>
                <div className="text-xs text-ink/50">{row.user.email} · issue {row.canIssue ? "yes" : "no"} · revoke {row.canRevoke ? "yes" : "no"}</div>
              </div>
              {row.user.role !== "INSTITUTION_ADMIN" && row.user.isActive ? (
                <Button tone="ghost" onClick={() => void api(`/api/v1/institutions/staff/${row.user.id}/deactivate`, { method: "POST" }).then(load)}>Deactivate</Button>
              ) : <span className="text-xs">{row.user.isActive ? row.user.role : "Inactive"}</span>}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

type StudentCertificate = { id: string; type: string; status: string; programName: string; academicYearBs: string; institutionName: string; verificationUrl: string };

export function StudentHome() {
  const [rows, setRows] = useState<StudentCertificate[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setRows(await api<StudentCertificate[]>("/api/v1/students/certificates"));
  }
  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Could not load certificates")); }, []);

  async function claim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/students/certificates/claim", {
        method: "POST",
        body: JSON.stringify({
          certificateId: form.get("certificateId"),
          dateOfBirth: form.get("dateOfBirth"),
          symbolOrRegNo: form.get("symbolOrRegNo"),
        }),
      });
      setMessage("Certificate linked to this account");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The certificate could not be claimed");
    }
  }

  return (
    <Shell title="My certificates">
      {error ? <div className="mb-3"><Alert tone="bad">{error}</Alert></div> : null}
      {message ? <div className="mb-3"><Alert tone="good">{message}</Alert></div> : null}
      <form className="mb-6 grid gap-3 sm:grid-cols-3" onSubmit={claim}>
        <Field label="Certificate identifier"><input className={controlClass} name="certificateId" required /></Field>
        <Field label="Date of birth"><input className={controlClass} name="dateOfBirth" type="date" required /></Field>
        <Field label="Symbol number"><input className={controlClass} name="symbolOrRegNo" required /></Field>
        <div className="sm:col-span-3"><Button type="submit">Link certificate</Button></div>
      </form>
      {rows.length === 0 ? <Empty title="No certificates linked" body="If the issuer used your account email, the certificate appears here. Otherwise claim it with the identifier, date of birth, and symbol number." /> : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-line bg-card p-4 text-sm">
              <div className="flex items-center justify-between"><h2 className="font-serif text-xl">{row.programName}</h2><StatusPill value={row.status} /></div>
              <p className="mt-1">{row.institutionName} · {row.type} · BS {row.academicYearBs}</p>
              <p className="mt-1 break-all text-xs">{row.id}</p>
              <p className="mt-1 break-all text-xs">{row.verificationUrl}</p>
              <div className="mt-3 flex gap-2">
                <Button tone="ghost" onClick={() => void downloadFile(`/api/v1/students/certificates/${row.id}/document`, `${row.id}.pdf`)}>Download</Button>
              </div>
              <img alt="Shareable verification QR" className="mt-3 w-40 rounded border border-line" src={`/api/v1/students/certificates/${row.id}/qr`} />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function PasswordPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{ user: { role: string } }>("/api/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }),
      });
      await refresh();
      navigate(user?.mustChangePassword ? homeAfter(data.user.role) : homeAfter(data.user.role));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Password">
      {user?.mustChangePassword ? <div className="mb-3"><Alert>Change the temporary password before using the rest of the workspace.</Alert></div> : null}
      <form className="max-w-md space-y-3" onSubmit={onSubmit}>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        <Field label="Current password"><input className={controlClass} name="currentPassword" type="password" required /></Field>
        <Field label="New password"><input className={controlClass} name="newPassword" type="password" required minLength={12} /></Field>
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Update password"}</Button>
      </form>
    </Shell>
  );
}

function homeAfter(role: string): string {
  if (role === "SUPER_ADMIN") return "/admin";
  if (role === "STUDENT") return "/student";
  if (role === "VERIFIER") return "/verify";
  return "/institution";
}

function countRows(source: CountMap | undefined, order: [string, string][]) {
  const known = new Set(order.map(([key]) => key));
  const rows = order.map(([key, label]) => ({ label, count: numberOf(source?.[key]) }));
  for (const [key, value] of Object.entries(source ?? {})) {
    if (!known.has(key)) rows.push({ label: labelFor(key), count: numberOf(value) });
  }
  return rows;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function labelFor(key: string): string {
  const words = key.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return key;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="rounded-lg border border-line bg-card p-4">
      <h2 className="text-sm text-ink/60">{title}</h2>
      {children}
    </article>
  );
}

function CountCard({ title, rows, hideZero = false, empty }: { title: string; rows: { label: string; count: number }[]; hideZero?: boolean; empty?: string }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const visible = hideZero ? rows.filter((row) => row.count > 0) : rows;
  return (
    <Card title={title}>
      <p className="mt-2 font-serif text-3xl">{total}</p>
      {visible.length === 0 && empty ? <p className="mt-2 text-sm text-ink/70">{empty}</p> : (
        <ul className="mt-3 space-y-1.5">
          {visible.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-4 text-sm">
              <span>{row.label}</span>
              <span className="tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
