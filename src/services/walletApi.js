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

export async function listWalletProfiles(profileId = "default") {
  const response = await fetch(`${API_BASE}/api/wallets?${profileQuery(profileId)}`, {
    headers: authHeaders(),
  });
  return checkedJson(response);
}

export async function upsertWalletProfile(profile, profileId = "default") {
  const response = await fetch(`${API_BASE}/api/wallets?${profileQuery(profileId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ ...profile, profileId }),
  });
  return checkedJson(response);
}

export async function deleteWalletProfile(address, profileId = "default") {
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}?${profileQuery(profileId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return checkedJson(response);
}

export async function getWalletLiveProfile(address) {
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/live`, {
    headers: authHeaders(),
  });
  return checkedJson(response);
}
