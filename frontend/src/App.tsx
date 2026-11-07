import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { ApplyPage, Landing, LoginPage, RegisterPage, VerifyPage } from "./pages/PublicPages";
import {
  AdminAudit,
  AdminHome,
  AdminInstitutions,
  AdminSettings,
  AdminUsers,
  CertificateDetail,
  CertificateList,
  InstitutionHome,
  IssuePage,
  PasswordPage,
  StaffPage,
  StudentHome,
} from "./pages/WorkPages";
import { homeFor } from "./ui";

function Guard({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-8 text-sm">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/account/password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

export function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={user ? <Navigate to={homeFor(user.role)} replace /> : <LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/apply" element={<ApplyPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/verify/:id" element={<VerifyPage />} />
      <Route path="/account/password" element={<PasswordGate><PasswordPage /></PasswordGate>} />
      <Route path="/admin" element={<Guard roles={["SUPER_ADMIN"]}><AdminHome /></Guard>} />
      <Route path="/admin/institutions" element={<Guard roles={["SUPER_ADMIN"]}><AdminInstitutions /></Guard>} />
      <Route path="/admin/users" element={<Guard roles={["SUPER_ADMIN"]}><AdminUsers /></Guard>} />
      <Route path="/admin/audit" element={<Guard roles={["SUPER_ADMIN"]}><AdminAudit /></Guard>} />
      <Route path="/admin/settings" element={<Guard roles={["SUPER_ADMIN"]}><AdminSettings /></Guard>} />
      <Route path="/institution" element={<Guard roles={["INSTITUTION_ADMIN", "INSTITUTION_STAFF"]}><InstitutionHome /></Guard>} />
      <Route path="/institution/issue" element={<Guard roles={["INSTITUTION_ADMIN", "INSTITUTION_STAFF"]}><IssuePage /></Guard>} />
      <Route path="/institution/certificates" element={<Guard roles={["INSTITUTION_ADMIN", "INSTITUTION_STAFF", "SUPER_ADMIN"]}><CertificateList /></Guard>} />
      <Route path="/institution/certificates/:id" element={<Guard roles={["INSTITUTION_ADMIN", "INSTITUTION_STAFF", "SUPER_ADMIN"]}><CertificateDetail /></Guard>} />
      <Route path="/institution/staff" element={<Guard roles={["INSTITUTION_ADMIN"]}><StaffPage /></Guard>} />
      <Route path="/student" element={<Guard roles={["STUDENT"]}><StudentHome /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function PasswordGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-8 text-sm">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}
