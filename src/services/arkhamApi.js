import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function getArkhamAddressIntelligence(address) {
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/arkham`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
