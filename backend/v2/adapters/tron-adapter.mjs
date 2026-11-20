import { createHash } from "node:crypto";
import { createNormalizedTransaction } from "../domain/transaction.mjs";
import { publicNetwork, validateAddressForNetwork } from "../networks/registry.mjs";
import { fetchJsonWithRetry } from "../providers/http-client.mjs";
import { NetworkAdapter, boundedInteger, decodeCursor, encodeCursor } from "./base-adapter.mjs";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buffer) {
  let value = BigInt(`0x${buffer.toString("hex") || "0"}`);
  let output = "";
  while (value > 0n) {
    output = BASE58_ALPHABET[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    output = BASE58_ALPHABET[0] + output;
  }
  return output || BASE58_ALPHABET[0];
}

function tronAddressFromHex(value) {
  if (!/^41[a-fA-F0-9]{40}$/.test(String(value || ""))) return String(value || "");
  const payload = Buffer.from(value, "hex");
  const first = createHash("sha256").update(payload).digest();
  const checksum = createHash("sha256").update(first).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function validRawInteger(value) {
  const text = String(value ?? "0");
  return /^\d+$/.test(text) ? text : "0";
}

function normalizeNative({ rows, network, observedAddress, provenance }) {
  return rows.flatMap((row) => {
    const contract = row.raw_data?.contract?.[0];
    if (contract?.type !== "TransferContract") return [];
    const value = contract.parameter?.value || {};
    const from = tronAddressFromHex(value.owner_address);
    const to = tronAddressFromHex(value.to_address);
    const txHash = row.txID || row.txid || "";
    return [createNormalizedTransaction({
      id: `${network.key}:${txHash}`,
      txHash,
      network: publicNetwork(network),
      observedAddress,
      block: { number: row.blockNumber ?? null },
      timestamp: row.block_timestamp,
      status: String(row.ret?.[0]?.contractRet || "unknown").toLowerCase(),
      operationType: "native_transfer",
      fromAddresses: [from].filter(Boolean),
      toAddresses: [to].filter(Boolean),
      amount: { raw: validRawInteger(value.amount), decimals: 6, symbol: "TRX", assetType: "native" },
      fee: row.fee ? { raw: validRawInteger(row.fee), decimals: 6, symbol: "TRX" } : null,
      explorerUrl: `${network.explorerBaseUrl}/transaction/${txHash}`,
      provenance,
      metadata: { contractType: contract.type },
    })];
  });
}

function normalizeTrc20({ rows, network, observedAddress, provenance }) {
  return rows.map((row, index) => {
    const token = row.token_info || {};
    const txHash = row.transaction_id || row.txID || row.hash || "";
    const contract = token.address || row.contract_address || null;
    const operationId = `${contract || "trc20"}:${index}`;
    return createNormalizedTransaction({
      id: `${network.key}:${txHash}:${operationId}`,
      txHash,
      operationId,
      network: publicNetwork(network),
      observedAddress,
      block: { number: row.block_number ?? row.blockNumber ?? null },
      timestamp: row.block_timestamp ?? row.timestamp,
      status: "confirmed",
      operationType: "token_transfer",
      fromAddresses: [row.from].filter(Boolean),
      toAddresses: [row.to].filter(Boolean),
      amount: {
        raw: validRawInteger(row.value ?? row.quant),
        decimals: boundedInteger(token.decimals ?? row.token_decimal, 6, 0, 36),
        symbol: token.symbol || row.token_symbol || "TRC20",
        assetType: "token",
        contractAddress: contract,
      },
      explorerUrl: `${network.explorerBaseUrl}/transaction/${txHash}`,
      provenance,
      metadata: { tokenName: token.name || row.token_name || null },
    });
  });
}

export class TronAdapter extends NetworkAdapter {
  constructor(options) {
    super(options);
    this.baseUrl = String(options.baseUrl || "https://api.trongrid.io").replace(/\/$/, "");
    this.requestIntervalMs = Math.max(250, Number(options.requestIntervalMs || 900));
    this.requestQueue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  validateAddress(address) {
    return validateAddressForNetwork(address, this.network.key);
  }

  async request({ address, path, fingerprint, limit, operation, attempts = 4, timeoutMs = 20_000 }) {
    const params = new URLSearchParams({
      limit: String(limit),
      only_confirmed: "true",
      order_by: "block_timestamp,desc",
    });
    if (fingerprint) params.set("fingerprint", fingerprint);
    const url = `${this.baseUrl}/v1/accounts/${encodeURIComponent(address)}/${path}?${params}`;
    const scheduled = async () => {
      const waitMs = Math.max(0, this.requestIntervalMs - (Date.now() - this.lastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        return await fetchJsonWithRetry(url, {
          provider: "TRON public API",
          fetchImpl: this.fetchImpl,
          attempts,
          baseDelayMs: 1_500,
          timeoutMs,
        });
      } finally {
        this.lastRequestAt = Date.now();
      }
    };
    const payloadPromise = this.requestQueue.then(scheduled, scheduled);
    this.requestQueue = payloadPromise.catch(() => undefined);
    const payload = await payloadPromise;
    const archived = await this.archive({
      provider: "TRON public API",
      operation,
      request: { url, address, limit, fingerprint: fingerprint || null },
      response: payload,
    });
    return { payload, archived };
  }

  async listTransactions({ address, limit = 25, cursor = "", from = null, to = null, requestProfile = "default" }) {
    if (!this.validateAddress(address)) {
      const error = new Error("Invalid TRON address");
      error.statusCode = 400;
      throw error;
    }
    const safeLimit = boundedInteger(limit, 25, 1, 100);
    const cursors = decodeCursor(cursor);
    const batchRequest = requestProfile === "batch" ? { attempts: 1, timeoutMs: 8_000 } : {};
    const [nativeResult, tokenResult] = await Promise.allSettled([
      this.request({ address, path: "transactions", fingerprint: cursors.native, limit: safeLimit, operation: "account_transactions", ...batchRequest }),
      this.request({ address, path: "transactions/trc20", fingerprint: cursors.trc20, limit: safeLimit, operation: "account_trc20_transactions", ...batchRequest }),
    ]);
    const errors = [];
    const items = [];
    const next = {};

    if (nativeResult.status === "fulfilled") {
      const { payload, archived } = nativeResult.value;
      next.native = payload.meta?.fingerprint || "";
      items.push(...normalizeNative({
        rows: payload.data || [],
        network: this.network,
        observedAddress: address,
        provenance: {
          provider: "TRON public API",
          retrievedAt: archived.retrievedAt,
          rawResponseId: archived.id,
          rawResponseHash: archived.contentHash,
        },
      }));
    } else {
      errors.push(nativeResult.reason?.message || "TRON native provider failed");
    }

    if (tokenResult.status === "fulfilled") {
      const { payload, archived } = tokenResult.value;
      next.trc20 = payload.meta?.fingerprint || "";
      items.push(...normalizeTrc20({
        rows: payload.data || [],
        network: this.network,
        observedAddress: address,
        provenance: {
          provider: "TRON public API",
          retrievedAt: archived.retrievedAt,
          rawResponseId: archived.id,
          rawResponseHash: archived.contentHash,
        },
      }));
    } else {
      errors.push(tokenResult.reason?.message || "TRON TRC20 provider failed");
    }

    if (nativeResult.status === "rejected" && tokenResult.status === "rejected") {
      throw new Error(errors.join(" | "));
    }

    const minTime = from ? Date.parse(from) : null;
    const maxTime = to ? Date.parse(to) : null;
    const filtered = items
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
      .filter((item) => !Number.isFinite(minTime) || (item.timestamp && Date.parse(item.timestamp) >= minTime))
      .filter((item) => !Number.isFinite(maxTime) || (item.timestamp && Date.parse(item.timestamp) <= maxTime))
      .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
      .slice(0, safeLimit);
    const hasMore = Boolean(next.native || next.trc20);
    return {
      items: filtered,
      pagination: { page: null, limit: safeLimit, cursor: hasMore ? encodeCursor(next) : null, hasMore },
      providers: ["TRON public API"],
      errors,
      completeness: errors.length ? "partial" : hasMore ? "paginated" : "complete_page",
    };
  }
}
