import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

function profileQuery(profileId) {
  return `profileId=${encodeURIComponent(profileId || "default")}`;
}

export async function listInvestigationCases(profileId = "default") {
  const response = await fetch(`${API_BASE}/api/cases?${profileQuery(profileId)}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function upsertInvestigationCase(payload, profileId = payload.profileId || "default") {
  const response = await fetch(`${API_BASE}/api/cases?${profileQuery(profileId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ ...payload, profileId }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function deleteInvestigationCase(id) {
  const response = await fetch(`${API_BASE}/api/cases/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
