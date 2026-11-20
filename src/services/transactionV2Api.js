import { authHeaders } from "./authApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function listV2Networks() {
  return apiRequest("/api/v2/networks");
}

export function detectV2Networks(address, { probe = false } = {}) {
  return apiRequest("/api/v2/networks/detect", {
    method: "POST",
    body: JSON.stringify({ address, probe }),
  });
}

export function analyzeV2AddressConnections({ addresses, networkKey, depth = 2, limitPerAddress = 50, from = "", to = "" }) {
  return apiRequest("/api/v2/address-connections", {
    method: "POST",
    body: JSON.stringify({ addresses, networkKey, depth, limitPerAddress, from: from || null, to: to || null }),
  });
}

function transactionForCurrentUi(tx) {
  const normalized = tx || {};
  const amount = normalized.amount || {};
  const from = normalized.fromAddresses?.[0] || "";
  const to = normalized.toAddresses?.[0] || "";
  const tokenType = amount.assetType === "token"
    ? normalized.network?.family === "tron" ? "TRC20" : "ERC20"
    : "native";
  return {
    hash: normalized.id || normalized.txHash,
    txHash: normalized.txHash,
    from,
    to,
    fromAddresses: normalized.fromAddresses || [],
    toAddresses: normalized.toAddresses || [],
    value: `${amount.value || "0"} ${amount.symbol || ""}`.trim(),
    rawValue: amount.raw || "0",
    amount: Number(amount.value || 0),
    tokenSymbol: amount.symbol || "",
    tokenDecimals: amount.decimals ?? 0,
    tokenContract: amount.contractAddress || "",
    tokenType,
    blockNumber: normalized.block?.number ?? null,
    timestamp: normalized.timestamp ? Date.parse(normalized.timestamp) : null,
    direction: normalized.direction,
    status: normalized.status,
    fee: normalized.fee ? `${normalized.fee.value} ${normalized.fee.symbol}` : "",
    networkKey: normalized.network?.key || "UNKNOWN",
    networkName: normalized.network?.name || "Unknown",
    explorerUrl: normalized.explorerUrl || "",
    provider: normalized.provenance?.provider || "",
    normalizedV2: normalized,
  };
}

export async function listV2Transactions({
  address,
  networkKey,
  page = 1,
  limit = 25,
  cursor = "",
  from = "",
  to = "",
  includeDust = false,
}) {
  const params = new URLSearchParams({ network: networkKey, page: String(page), limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const result = await apiRequest(`/api/v2/addresses/${encodeURIComponent(address)}/transactions?${params}`);
  const mappedItems = (result.items || []).map(transactionForCurrentUi);
  const dustItems = networkKey === "TRX"
    ? mappedItems.filter((tx) => tx.tokenType === "native" && BigInt(tx.rawValue || "0") < 1_000_000n)
    : [];
  const items = includeDust ? mappedItems : mappedItems.filter((tx) => !dustItems.includes(tx));
  return {
    ...result,
    items,
    hasMore: Boolean(result.pagination?.hasMore),
    fingerprint: result.pagination?.cursor || "",
    dustFilteredCount: includeDust ? 0 : dustItems.length,
    dustMinAmount: "1 TRX",
    provider: result.dataQuality?.sourceProviders?.join(" + ") || "API v2",
    errors: result.dataQuality?.errors || [],
    scannedNetworks: result.scannedNetworks || [result.network?.name].filter(Boolean),
    skippedNetworks: result.skippedNetworks || [],
    dataQuality: {
      ...result.dataQuality,
      sourceProvider: result.dataQuality?.sourceProviders?.join(" + ") || "API v2",
    },
  };
}
