const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";
const AUTH_KEY = "chainSentinelAuth";
let inMemorySession = null;

export function loadAuthSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return stored || inMemorySession;
  } catch {
    // Some embedded browsers can restrict localStorage. A running session must
    // still be usable there; persistence will resume when storage is available.
    return inMemorySession;
  }
}

export function saveAuthSession(session) {
  inMemorySession = session;
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  } catch {
    // Keep the current local session active without persistent browser storage.
  }
}

export function clearAuthSession() {
  inMemorySession = null;
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // Nothing else to clear when storage is unavailable.
  }
}

export function authHeaders() {
  const session = loadAuthSession();
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
}

async function authRequest(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  saveAuthSession(body);
  return body;
}

export function loginUser(payload) {
  return authRequest("/api/auth/login", payload);
}

export function registerUser(payload) {
  return authRequest("/api/auth/register", payload);
}

export async function logoutUser() {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: authHeaders(),
    });
  } finally {
    clearAuthSession();
  }
}

export async function getCurrentUser() {
  const response = await fetch(`${API_BASE}/api/auth/me`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
