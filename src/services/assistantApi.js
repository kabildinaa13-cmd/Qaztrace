import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

async function readAssistantResponse(response) {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;

    try {
      const payload = await response.json();
      message = payload.error || payload.message || message;
    } catch {
      // Keep HTTP status fallback.
    }

    throw new Error(message);
  }

  return response.json();
}

export async function getAssistantStatus() {
  const response = await fetch(`${API_BASE}/api/assistant/status`, {
    headers: authHeaders(),
  });
  return readAssistantResponse(response);
}

export async function askInvestigatorAssistant({ message, history = [], context = {} }) {
  const response = await fetch(`${API_BASE}/api/assistant/chat`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, history, context }),
  });
  return readAssistantResponse(response);
}
