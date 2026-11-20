import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function listEntityLabels() {
  const response = await fetch(`${API_BASE}/api/entities`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function upsertEntityLabel(label) {
  const response = await fetch(`${API_BASE}/api/entities`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(label),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function deleteEntityLabel(id) {
  const response = await fetch(`${API_BASE}/api/entities/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function importOfacEntityLabels(files = []) {
  const response = await fetch(`${API_BASE}/api/entities/ofac`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(files.length ? { files } : {}),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;

    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep HTTP status fallback.
    }

    throw new Error(message);
  }

  return response.json();
}

export async function importCsvEntityLabels(csv) {
  const response = await fetch(`${API_BASE}/api/entities/import-csv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ csv }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
