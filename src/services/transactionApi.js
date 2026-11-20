import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function listWalletTransactions({
  address,
  networkKey = "ETH",
  page = 1,
  limit = 25,
  fingerprint = "",
  includeDust = false,
  minAmountSun = 1000000,
}) {
  const params = new URLSearchParams({
    networkKey,
    page: String(page),
    limit: String(limit),
  });

  if (fingerprint) {
    params.set("fingerprint", fingerprint);
  }

  if (networkKey === "TRX") {
    params.set("includeDust", String(includeDust));
    params.set("minAmountSun", String(minAmountSun));
  }

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/transactions?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function getWalletGraph({
  address,
  networkKey = "ETH",
  depth = 4,
  maxNodes = 80,
  perAddressLimit = 10,
  startAt = "",
  endAt = "",
  flowDirection = "outgoing",
}) {
  const params = new URLSearchParams({
    networkKey,
    depth: String(depth),
    maxNodes: String(maxNodes),
    perAddressLimit: String(perAddressLimit),
    flowDirection,
  });

  if (startAt) params.set("startAt", startAt);
  if (endAt) params.set("endAt", endAt);

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/graph?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function getWalletGraphNeighbors({
  address,
  networkKey = "ETH",
  maxNodes = 30,
  perAddressLimit = 10,
  startAt = "",
  endAt = "",
  flowDirection = "outgoing",
}) {
  const params = new URLSearchParams({
    networkKey,
    maxNodes: String(maxNodes),
    perAddressLimit: String(perAddressLimit),
    flowDirection,
  });

  if (startAt) params.set("startAt", startAt);
  if (endAt) params.set("endAt", endAt);

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/graph-neighbors?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function traceWalletFunds({
  address,
  networkKey = "TRX",
  tokenSymbol = "USDT",
  startAt,
  endAt,
  seedTxHash = "",
  amount = "",
  depth = 3,
  hopWindowHours = 72,
  maxBranches = 8,
  maxSeeds = 20,
}) {
  const params = new URLSearchParams({
    networkKey,
    tokenSymbol,
    startAt,
    endAt,
    depth: String(depth),
    hopWindowHours: String(hopWindowHours),
    maxBranches: String(maxBranches),
    maxSeeds: String(maxSeeds),
  });

  if (seedTxHash.trim()) {
    params.set("seedTxHash", seedTxHash.trim());
  }

  if (String(amount).trim()) {
    params.set("amount", String(amount).trim());
  }

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/fund-trace?${params}`, {
    headers: authHeaders(),
  });

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

export async function getMixerChainScan({
  address,
  networkKey = "ETH",
  depth = 2,
  maxPerHop = 4,
  limit = 80,
  saveEntities = true,
  persist = true,
  refresh = false,
}) {
  const params = new URLSearchParams({
    networkKey,
    depth: String(depth),
    maxPerHop: String(maxPerHop),
    limit: String(limit),
    saveEntities: String(saveEntities),
    persist: String(persist),
  });

  if (refresh) {
    params.set("refresh", "true");
  }

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/mixer-chain-scan?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function getLatestMixerChainScan({ address, networkKey = "" }) {
  const params = new URLSearchParams();

  if (networkKey) {
    params.set("networkKey", networkKey);
  }

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/mixer-chain-scans/latest?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function listMixerChainScans({ address, networkKey = "", limit = 10 }) {
  const params = new URLSearchParams({ limit: String(limit) });

  if (networkKey) {
    params.set("networkKey", networkKey);
  }

  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/mixer-chain-scans?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function getWalletRisk({ address, networkKey = "ETH", mode = "full", refresh = false }) {
  const params = new URLSearchParams({
    networkKey,
    mode,
  });
  if (refresh) {
    params.set("refresh", "true");
  }
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/risk?${params}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function getWalletTokens({ address, networkKey = "ETH", limit = 40 }) {
  const params = new URLSearchParams({
    networkKey,
    limit: String(limit),
  });
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/tokens?${params}`, {
    headers: authHeaders(),
  });

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

export async function getWalletNfts({ address, networkKey = "ETH", limit = 24 }) {
  const params = new URLSearchParams({
    networkKey,
    limit: String(limit),
  });
  const response = await fetch(`${API_BASE}/api/wallets/${encodeURIComponent(address)}/nfts?${params}`, {
    headers: authHeaders(),
  });

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
