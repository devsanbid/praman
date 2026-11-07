import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { resultPresentation, type VerificationResult } from "../results";
import { Alert, Button, Field, controlClass, homeFor } from "../ui";

type Notice = { name: string; notice: string; limitations: string[]; demoAccounts?: DemoAccount[] };

type DemoAccount = { label: string; email: string; password: string; hint: string };

const fallbackDemoAccounts: DemoAccount[] = [
  { label: "Administrator", email: "admin@praman.local", password: "PramanDemo2082", hint: "Approve institutions, users, and the audit log" },
  { label: "SEE board", email: "see@praman.demo", password: "PramanDemo2082", hint: "Issue an SEE certificate" },
  { label: "+2 school", email: "plus2@praman.demo", password: "PramanDemo2082", hint: "Issue a higher-secondary certificate" },
  { label: "University", email: "university@praman.demo", password: "PramanDemo2082", hint: "Issue a university certificate" },
  { label: "Student", email: "student@praman.demo", password: "PramanDemo2082", hint: "Open the sample certificate" },
  { label: "Verifier", email: "verifier@praman.demo", password: "PramanDemo2082", hint: "Check a certificate file" },
];

type Verification = {
  result: VerificationResult;
  documentChecked: boolean;
  certificateId: string | null;
  certificateType: string | null;
  institutionName: string | null;
  institutionStatus: string | null;
  issuerStatus: string | null;
  certificateStatus: string | null;
  academicYearBs: string | null;
  programName: string | null;
  campusOrSchool: string | null;
  issueDate: string | null;
  issuedAt: string | null;
  revokedAt: string | null;
  verifiedAt: string;
  message: string;
  limitations: string[];
  holder: { fullName: string; dateOfBirth: string; symbolOrRegNo: string; gpaOrDivision: string } | null;
};

export function Landing() {
  const [meta, setMeta] = useState<Notice | null>(null);
  useEffect(() => {
    void api<Notice>("/api/v1/meta").then(setMeta).catch(() => setMeta(null));
  }, []);
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <span className="font-serif text-2xl">Praman</span>
          <nav className="flex gap-4 text-sm">
            <Link to="/verify">Verify</Link>
            <Link to="/apply">Institution access</Link>
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-12">
        <p className="text-sm uppercase tracking-wide text-brass">Nepal · research prototype</p>
        <h1 className="mt-3 max-w-3xl font-serif text-5xl leading-tight">Check an academic certificate without calling the school.</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink/80">
          Approved institutions record a SHA-256 fingerprint of each certificate on a permissioned Hyperledger Fabric network.
          Employers and universities compare a file with that fingerprint. The ledger does not store the student record.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/verify" className="rounded-md bg-pine px-4 py-2 text-sm text-white">Verify a certificate</Link>
          <Link to="/register" className="rounded-md border border-line bg-card px-4 py-2 text-sm">Create a student or verifier account</Link>
        </div>
        <DemoSignIn accounts={meta?.demoAccounts} />
        {meta?.notice ? <div className="mt-6"><Alert>{meta.notice}</Alert></div> : null}
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            ["1. Approve the issuer", "A platform administrator enrols the institution and gives it a Fabric identity before it can write."],
            ["2. Record the fingerprint", "The PDF stays off-chain. The ledger keeps the identifier, hash, issuer, status, and time."],
            ["3. Compare the file", "A match means this file was recorded and not revoked. It does not prove who is holding it."],
          ].map(([title, body]) => (
            <article key={title} className="rounded-lg border border-line bg-card p-4">
              <h2 className="font-serif text-xl">{title}</h2>
              <p className="mt-2 text-sm text-ink/75">{body}</p>
            </article>
          ))}
        </div>
        <aside className="mt-8 rounded-lg border border-brass/30 bg-amber-50 p-4 text-sm">
          Praman is a final-year computer science prototype. It is not a system of the Government of Nepal, NEB, or any university.
          Generated documents are labelled as prototype certificates.
        </aside>
      </main>
    </div>
  );
}

export function DemoSignIn({ accounts }: { accounts?: DemoAccount[] }) {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState("");
  const [busyEmail, setBusyEmail] = useState("");
  const rows = accounts?.length ? accounts : fallbackDemoAccounts;

  async function openAccount(account: DemoAccount) {
    setBusyEmail(account.email);
    setError("");
    try {
      const data = await api<{ user: { role: string; mustChangePassword: boolean } }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: account.email, password: account.password }),
      });
      await refresh();
      navigate(data.user.mustChangePassword ? "/account/password" : homeFor(data.user.role));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That demo sign-in failed");
    } finally {
      setBusyEmail("");
    }
  }

  return (
    <section className="mt-8">
      <h2 className="font-serif text-2xl">Open a demo account</h2>
      <p className="mt-1 text-sm text-ink/70">Click a card. The password for every prototype account is <span className="font-medium text-ink">{rows[0]?.password}</span>. A student cannot open the university pages, and a verifier cannot issue certificates.</p>
      {error ? <div className="mt-3"><Alert tone="bad">{error}</Alert></div> : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((account) => (
          <button
            key={account.email}
            type="button"
            disabled={busyEmail !== ""}
            onClick={() => void openAccount(account)}
            className="rounded-lg border border-line bg-card p-4 text-left hover:border-pine disabled:opacity-60"
          >
            <span className="block font-serif text-xl">{account.label}</span>
            <span className="mt-2 block text-sm">{account.email}</span>
            <span className="mt-1 block text-sm text-ink/70">Password {account.password}</span>
            <span className="mt-2 block text-xs text-ink/60">{account.hint}</span>
            <span className="mt-3 inline-block text-sm text-pine">{busyEmail === account.email ? "Opening…" : "Open"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<DemoAccount[] | undefined>();
  useEffect(() => {
    void api<Notice>("/api/v1/meta").then((meta) => setAccounts(meta.demoAccounts)).catch(() => setAccounts(undefined));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{ user: { role: string; mustChangePassword: boolean } }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      await refresh();
      navigate(data.user.mustChangePassword ? "/account/password" : homeFor(data.user.role));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard wide title="Sign in" footer={<Link to="/register">Create a student or verifier account</Link>}>
      <DemoSignIn accounts={accounts} />
      <form className="mt-8 space-y-3" onSubmit={onSubmit}>
        <p className="text-sm text-ink/70">Or type a different account.</p>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        <Field label="Email"><input className={controlClass} name="email" type="email" required autoComplete="username" /></Field>
        <Field label="Password"><input className={controlClass} name="password" type="password" required autoComplete="current-password" /></Field>
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{ user: { role: string } }>("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          role: form.get("role"),
          fullName: form.get("fullName"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      await refresh();
      navigate(homeFor(data.user.role));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Create an account" footer={<Link to="/apply">Register an institution instead</Link>}>
      <form className="space-y-3" onSubmit={onSubmit}>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        <Field label="I am a">
          <select className={controlClass} name="role" defaultValue="STUDENT">
            <option value="STUDENT">Student</option>
            <option value="VERIFIER">Employer or university verifier</option>
          </select>
        </Field>
        <Field label="Full name"><input className={controlClass} name="fullName" required minLength={3} /></Field>
        <Field label="Email"><input className={controlClass} name="email" type="email" required /></Field>
        <Field label="Password"><input className={controlClass} name="password" type="password" required minLength={12} /></Field>
        <p className="text-xs text-ink/60">Use at least 12 characters, with a letter and a number. Institutions apply separately and wait for approval.</p>
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
    </AuthCard>
  );
}

export function ApplyPage() {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      await api("/api/v1/institutions/applications", { method: "POST", body: JSON.stringify(body) });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The application could not be submitted");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link to="/" className="text-sm text-pine">Back</Link>
      <h1 className="mt-3 font-serif text-4xl">Request institution access</h1>
      <p className="mt-2 text-sm text-ink/70">The account stays inactive until a platform administrator approves it and enrols a blockchain identity.</p>
      {done ? <div className="mt-6"><Alert tone="good">Application received. You can sign in after it is approved.</Alert></div> : (
        <form className="mt-6 grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
          {error ? <div className="sm:col-span-2"><Alert tone="bad">{error}</Alert></div> : null}
          <Field label="Institution name"><input className={controlClass} name="name" required /></Field>
          <Field label="Type">
            <select className={controlClass} name="type" defaultValue="SEE_BOARD">
              <option value="SEE_BOARD">SEE board</option>
              <option value="PLUS_TWO">Higher secondary (+2)</option>
              <option value="UNIVERSITY">University</option>
            </select>
          </Field>
          <Field label="Registration number"><input className={controlClass} name="registrationNumber" required /></Field>
          <Field label="Province">
            <select className={controlClass} name="province" defaultValue="Bagmati">
              {["Koshi", "Madhesh", "Bagmati", "Gandaki", "Lumbini", "Karnali", "Sudurpashchim"].map((item) => <option key={item}>{item}</option>)}
            </select>
          </Field>
          <Field label="District"><input className={controlClass} name="district" required /></Field>
          <Field label="Phone"><input className={controlClass} name="phone" required /></Field>
          <div className="sm:col-span-2"><Field label="Address"><input className={controlClass} name="addressLine" required /></Field></div>
          <Field label="Institution email"><input className={controlClass} name="email" type="email" required /></Field>
          <Field label="Website"><input className={controlClass} name="website" placeholder="https://" /></Field>
          <Field label="Representative name"><input className={controlClass} name="representativeName" required /></Field>
          <Field label="Title"><input className={controlClass} name="representativeTitle" required /></Field>
          <Field label="Representative email"><input className={controlClass} name="representativeEmail" type="email" required /></Field>
          <Field label="Password"><input className={controlClass} name="password" type="password" required minLength={12} /></Field>
          <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button></div>
        </form>
      )}
    </div>
  );
}

export function VerifyPage() {
  const params = useParams();
  const { user } = useAuth();
  const [certificateId, setCertificateId] = useState(params.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    setCertificateId(params.id);
    setBusy(true);
    void api<Verification>(`/api/v1/verify/${encodeURIComponent(params.id)}`)
      .then(setResult)
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Verification failed"))
      .finally(() => setBusy(false));
  }, [params.id]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose the PDF to compare");
      return;
    }
    setBusy(true);
    setError("");
    const body = new FormData();
    body.set("document", file);
    if (certificateId.trim()) body.set("certificateId", certificateId.trim());
    try {
      setResult(await api<Verification>("/api/v1/verify", { method: "POST", body }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  const view = result ? resultPresentation(result.result, result.documentChecked) : null;
  const toneClass = view?.tone === "good" ? "border-emerald-300 bg-emerald-50" : view?.tone === "bad" ? "border-red-300 bg-red-50" : view?.tone === "warn" ? "border-amber-300 bg-amber-50" : "border-line bg-card";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center justify-between">
        <Link to={user ? homeFor(user.role) : "/"} className="text-sm text-pine">{user ? "Workspace" : "Praman"}</Link>
        {!user ? <Link to="/login" className="text-sm">Sign in</Link> : null}
      </div>
      <h1 className="mt-4 font-serif text-4xl">Verify a certificate</h1>
      <p className="mt-2 text-sm text-ink/70">Upload the PDF. A visual match or a QR code alone is not evidence. A signed-in check can show holder details only when the file fingerprint matches.</p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        <Field label="Certificate identifier, if you have it">
          <input className={controlClass} value={certificateId} onChange={(event) => setCertificateId(event.target.value)} placeholder="NPL-SEE-2082-…" />
        </Field>
        <Field label="Certificate PDF">
          <input className={controlClass} type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Compare with the ledger"}</Button>
      </form>
      {view && result ? (
        <section className={`mt-6 rounded-lg border p-4 ${toneClass}`}>
          <p className="text-xs uppercase tracking-wide text-ink/60">{result.documentChecked ? "File compared" : "Status only"}</p>
          <h2 className="font-serif text-2xl">{view.title}</h2>
          <p className="mt-2 text-sm">{result.message}</p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <Item label="Identifier" value={result.certificateId} />
            <Item label="Type" value={result.certificateType} />
            <Item label="Institution" value={result.institutionName} />
            <Item label="Issuer standing" value={result.issuerStatus} />
            <Item label="Certificate status" value={result.certificateStatus} />
            <Item label="Programme" value={result.programName} />
            <Item label="Campus or school" value={result.campusOrSchool} />
            <Item label="Academic year (BS)" value={result.academicYearBs} />
            <Item label="Issue date" value={result.issueDate} />
            <Item label="Recorded at" value={result.issuedAt} />
            <Item label="Revoked at" value={result.revokedAt} />
            <Item label="Checked at" value={result.verifiedAt} />
          </dl>
          {result.holder ? (
            <div className="mt-4 rounded-md bg-white/70 p-3 text-sm">
              <p className="font-medium">Holder details, shown because this signed-in check matched the file.</p>
              <p className="mt-1">{result.holder.fullName} · {result.holder.symbolOrRegNo} · {result.holder.gpaOrDivision} · born {result.holder.dateOfBirth}</p>
            </div>
          ) : null}
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-ink/70">
            {result.limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <div><dt className="text-ink/50">{label}</dt><dd>{value}</dd></div>;
}

function AuthCard({ title, children, footer, wide = false }: { title: string; children: React.ReactNode; footer: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto px-4 py-12 ${wide ? "max-w-5xl" : "max-w-md"}`}>
      <Link to="/" className="font-serif text-2xl">Praman</Link>
      <h1 className="mt-6 font-serif text-3xl">{title}</h1>
      <div className="mt-4">{children}</div>
      <p className="mt-4 text-sm text-pine">{footer}</p>
    </div>
  );
}
