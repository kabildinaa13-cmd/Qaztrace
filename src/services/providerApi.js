const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function getProviderCapabilities() {
  const response = await fetch(`${API_BASE}/api/providers`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
