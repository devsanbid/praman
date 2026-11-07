import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "./auth";

export function Button({
  children,
  tone = "primary",
  type = "button",
  disabled,
  onClick,
}: {
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const tones = {
    primary: "bg-pine text-white hover:bg-ink",
    ghost: "border border-line bg-card text-ink hover:bg-paper",
    danger: "bg-red-800 text-white hover:bg-red-950",
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink/80">{label}</span>
      {children}
    </label>
  );
}

export const controlClass = "w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-pine";

export function Alert({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "bad" | "good" }) {
  const tones = {
    warn: "border-brass/40 bg-amber-50 text-amber-950",
    bad: "border-red-200 bg-red-50 text-red-950",
    good: "border-emerald-200 bg-emerald-50 text-emerald-950",
  };
  return <div className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>;
}

export function StatusPill({ value }: { value: string }) {
  const tone = value === "VALID" || value === "APPROVED" || value === "ACTIVE"
    ? "bg-emerald-100 text-emerald-900"
    : value === "REVOKED" || value === "SUSPENDED" || value === "REJECTED" || value === "TAMPERED"
      ? "bg-red-100 text-red-900"
      : "bg-stone-200 text-stone-800";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{value}</span>;
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-card px-6 py-10 text-center">
      <h2 className="font-serif text-xl">{title}</h2>
      <p className="mt-2 text-sm text-ink/70">{body}</p>
    </div>
  );
}

export function Modal({
  title,
  body,
  confirm,
  busy,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-xl" role="dialog" aria-modal="true">
        <h2 className="font-serif text-xl">{title}</h2>
        <p className="mt-2 text-sm text-ink/75">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button tone="ghost" onClick={onClose}>Cancel</Button>
          <Button tone={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>{busy ? "Working…" : confirm}</Button>
        </div>
      </div>
    </div>
  );
}

const links: Record<string, Array<{ to: string; label: string }>> = {
  SUPER_ADMIN: [
    { to: "/admin", label: "Overview" },
    { to: "/admin/institutions", label: "Institutions" },
    { to: "/admin/users", label: "Users" },
    { to: "/admin/audit", label: "Audit" },
    { to: "/admin/settings", label: "Settings" },
    { to: "/verify", label: "Verify" },
  ],
  INSTITUTION_ADMIN: [
    { to: "/institution", label: "Overview" },
    { to: "/institution/issue", label: "Issue" },
    { to: "/institution/certificates", label: "Certificates" },
    { to: "/institution/staff", label: "Staff" },
  ],
  INSTITUTION_STAFF: [
    { to: "/institution", label: "Overview" },
    { to: "/institution/issue", label: "Issue" },
    { to: "/institution/certificates", label: "Certificates" },
  ],
  STUDENT: [
    { to: "/student", label: "My certificates" },
    { to: "/verify", label: "Verify" },
  ],
  VERIFIER: [{ to: "/verify", label: "Verify" }],
};

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { user, signOut } = useAuth();
  const items = user ? links[user.role] ?? [] : [];
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="font-serif text-xl">Praman</Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden sm:inline text-paper/70">{user?.fullName}</span>
            <button type="button" className="underline" onClick={() => void signOut().then(() => { window.location.href = "/"; })}>Sign out</button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 md:grid-cols-[180px_1fr]">
        <nav className="flex gap-2 overflow-auto md:flex-col">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/admin" || item.to === "/institution" || item.to === "/student" || item.to === "/verify"}
              className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? "bg-ink text-paper" : "text-ink/80 hover:bg-white"}`}
            >
              {item.label}
            </NavLink>
          ))}
          <NavLink to="/account/password" className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? "bg-ink text-paper" : "text-ink/80 hover:bg-white"}`}>Password</NavLink>
        </nav>
        <main>
          <h1 className="font-serif text-3xl">{title}</h1>
          <div className="mt-5">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function homeFor(role: string): string {
  if (role === "SUPER_ADMIN") return "/admin";
  if (role === "STUDENT") return "/student";
  if (role === "VERIFIER") return "/verify";
  return "/institution";
}
