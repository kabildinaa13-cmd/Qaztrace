import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function listAuditEvents(limit = 100) {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`${API_BASE}/api/audit?${params}`, {
    headers: authHeaders(),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return body;
}
