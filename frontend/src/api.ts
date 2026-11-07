export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Role = "SUPER_ADMIN" | "INSTITUTION_ADMIN" | "INSTITUTION_STAFF" | "STUDENT" | "VERIFIER";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  institutionId: string | null;
  institutionStatus: string | null;
  canIssue: boolean;
  canRevoke: boolean;
  canManageStaff: boolean;
  mustChangePassword: boolean;
};

function csrfToken(): string | undefined {
  const row = document.cookie.split("; ").find((part) => part.startsWith("praman_csrf="));
  if (!row) return undefined;
  return decodeURIComponent(row.slice("praman_csrf=".length));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    const token = csrfToken();
    if (token) headers.set("x-csrf-token", token);
  }
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok) {
    throw new ApiError(response.status, payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "The request failed");
  }
  return payload.data as T;
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new ApiError(response.status, "DOWNLOAD_FAILED", "The file could not be downloaded");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
