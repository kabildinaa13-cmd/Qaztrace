import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

function profileQuery(profileId) {
  return `profileId=${encodeURIComponent(profileId || "default")}`;
}

async function checkedJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export async function listWatchlistRules(profileId = "default") {
  const response = await fetch(`${API_BASE}/api/watchlist?${profileQuery(profileId)}`, {
    headers: authHeaders(),
  });
  return checkedJson(response);
}

export async function upsertWatchlistRule(rule, profileId = rule.profileId || "default") {
  const response = await fetch(`${API_BASE}/api/watchlist?${profileQuery(profileId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ ...rule, profileId }),
  });
  return checkedJson(response);
}

export async function deleteWatchlistRule(id) {
  const response = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return checkedJson(response);
}

export async function listAlertEvents(profileId = "default") {
  const response = await fetch(`${API_BASE}/api/alerts?${profileQuery(profileId)}`, {
    headers: authHeaders(),
  });
  return checkedJson(response);
}

export async function pollWatchlistNow(profileId = "default") {
  const response = await fetch(`${API_BASE}/api/watchlist/poll?${profileQuery(profileId)}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return checkedJson(response);
}
