export const TRANSACTION_SCHEMA_VERSION = "2.0";

export function decimalString(rawValue, decimals) {
  const negative = String(rawValue || "0").startsWith("-");
  const digits = String(rawValue || "0").replace(/^-/, "").replace(/^0+(?=\d)/, "") || "0";
  const safeDecimals = Math.max(0, Number(decimals || 0));
  if (!safeDecimals) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(safeDecimals + 1, "0");
  const whole = padded.slice(0, -safeDecimals);
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return new Date(milliseconds).toISOString();
}

export function observedDirection(observedAddress, fromAddresses = [], toAddresses = []) {
  const observed = String(observedAddress || "").toLowerCase();
  const from = fromAddresses.map((value) => String(value || "").toLowerCase());
  const to = toAddresses.map((value) => String(value || "").toLowerCase());
  if (from.includes(observed) && to.includes(observed)) return "self";
  if (from.includes(observed)) return "out";
  if (to.includes(observed)) return "in";
  return "unknown";
}

export function createNormalizedTransaction(input) {
  const rawValue = String(input.amount?.raw ?? "0");
  const decimals = Number(input.amount?.decimals ?? input.network.decimals ?? 0);
  const tx = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    id: String(input.id || input.txHash),
    txHash: String(input.txHash || ""),
    operationId: input.operationId ? String(input.operationId) : null,
    network: {
      key: input.network.key,
      name: input.network.name,
      family: input.network.family,
      chainId: input.network.chainId ?? null,
    },
    block: {
      number: input.block?.number ?? null,
      hash: input.block?.hash || null,
      confirmations: input.block?.confirmations ?? null,
    },
    timestamp: normalizeTimestamp(input.timestamp),
    status: input.status || "unknown",
    operationType: input.operationType || "transfer",
    direction: input.direction || observedDirection(input.observedAddress, input.fromAddresses, input.toAddresses),
    fromAddresses: [...new Set((input.fromAddresses || []).filter(Boolean))],
    toAddresses: [...new Set((input.toAddresses || []).filter(Boolean))],
    amount: {
      raw: rawValue,
      decimals,
      value: decimalString(rawValue, decimals),
      symbol: input.amount?.symbol || input.network.symbol,
      assetType: input.amount?.assetType || "native",
      contractAddress: input.amount?.contractAddress || null,
    },
    fee: input.fee
      ? {
          raw: String(input.fee.raw ?? "0"),
          decimals: Number(input.fee.decimals ?? input.network.decimals ?? 0),
          value: decimalString(input.fee.raw ?? "0", input.fee.decimals ?? input.network.decimals ?? 0),
          symbol: input.fee.symbol || input.network.symbol,
        }
      : null,
    inputs: Array.isArray(input.inputs) ? input.inputs : [],
    outputs: Array.isArray(input.outputs) ? input.outputs : [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    explorerUrl: input.explorerUrl || null,
    provenance: {
      provider: input.provenance.provider,
      retrievedAt: input.provenance.retrievedAt,
      rawResponseId: input.provenance.rawResponseId,
      rawResponseHash: input.provenance.rawResponseHash,
    },
  };

  assertNormalizedTransaction(tx);
  return tx;
}

export function assertNormalizedTransaction(tx) {
  if (!tx?.txHash) throw new Error("Normalized transaction must contain txHash");
  if (!tx?.network?.key || !tx?.network?.family) throw new Error("Normalized transaction must contain network metadata");
  if (!tx?.provenance?.provider || !tx?.provenance?.rawResponseHash) {
    throw new Error("Normalized transaction must contain provider provenance");
  }
  if (!Array.isArray(tx.fromAddresses) || !Array.isArray(tx.toAddresses)) {
    throw new Error("Normalized transaction address fields must be arrays");
  }
  if (!/^-?\d+$/.test(tx.amount.raw)) throw new Error("Normalized raw amount must be an integer string");
  return tx;
}

export function toLegacyTransaction(tx) {
  const primaryFrom = tx.fromAddresses?.[0] || "";
  const primaryTo = tx.toAddresses?.[0] || "";
  const tokenType = tx.amount.assetType === "token"
    ? tx.network.family === "tron" ? "TRC20" : "ERC20"
    : "native";
  return {
    hash: tx.id,
    txHash: tx.txHash,
    from: primaryFrom,
    to: primaryTo,
    fromAddresses: tx.fromAddresses || [],
    toAddresses: tx.toAddresses || [],
    value: `${tx.amount.value} ${tx.amount.symbol}`,
    rawValue: tx.amount.raw,
    amount: Number(tx.amount.value),
    tokenSymbol: tx.amount.symbol,
    tokenDecimals: tx.amount.decimals,
    tokenContract: tx.amount.contractAddress || "",
    tokenType,
    blockNumber: tx.block?.number ?? null,
    timestamp: tx.timestamp ? Date.parse(tx.timestamp) : null,
    direction: tx.direction,
    status: tx.status,
    fee: tx.fee ? `${tx.fee.value} ${tx.fee.symbol}` : "",
    networkKey: tx.network.key,
    networkName: tx.network.name,
    explorerUrl: tx.explorerUrl || "",
    provider: tx.provenance.provider,
    normalizedV2: tx,
  };
}
