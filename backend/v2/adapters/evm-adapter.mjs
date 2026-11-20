import { createNormalizedTransaction } from "../domain/transaction.mjs";
import { publicNetwork, validateAddressForNetwork } from "../networks/registry.mjs";
import { fetchJsonWithRetry } from "../providers/http-client.mjs";
import { NetworkAdapter, boundedInteger } from "./base-adapter.mjs";

const DEFAULT_ROUTESCAN = "https://api.routescan.io";
const DEFAULT_ETHERSCAN = "https://api.etherscan.io";
const DEFAULT_BLOCKSCOUT = {
  ETH: "https://eth.blockscout.com",
  ARB: "https://arbitrum.blockscout.com",
  BASE: "https://base.blockscout.com",
  CELO: "https://celo.blockscout.com",
  HEMI: "https://explorer.hemi.xyz",
  LINEA: "https://explorer.linea.build",
  MEGAETH: "https://megaeth.blockscout.com",
  OP: "https://explorer.optimism.io",
  POLYGON: "https://polygon.blockscout.com",
  SCROLL: "https://scroll.blockscout.com",
  UNICHAIN: "https://unichain.blockscout.com",
  ZKSYNC: "https://zksync.blockscout.com",
};
const DEFAULT_BINPLORER = {
  BNB: "https://api.binplorer.com",
};
let routescanQueue = Promise.resolve();
let lastRoutescanRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchRoutescanQueued(url, options) {
  const run = routescanQueue.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - lastRoutescanRequestAt;
    if (elapsed < 300) await wait(300 - elapsed);
    lastRoutescanRequestAt = Date.now();
    return fetchJsonWithRetry(url, options);
  });
  routescanQueue = run.catch(() => undefined);
  return run;
}

function statusFromEtherscanRow(row) {
  if (String(row.isError || "0") === "1" || String(row.txreceipt_status || "1") === "0") return "failed";
  return row.blockNumber ? "confirmed" : row.success === false ? "failed" : "confirmed";
}

function numericString(value, fallback = "0") {
  const text = String(value ?? fallback);
  return /^\d+$/.test(text) ? text : fallback;
}

function redactApiKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("apikey")) parsed.searchParams.set("apikey", "REDACTED");
    if (parsed.searchParams.has("apiKey")) parsed.searchParams.set("apiKey", "REDACTED");
    return parsed.toString();
  } catch {
    return url;
  }
}

function readableProviderError(error, provider, network) {
  const detail = String(error?.message || error || "неизвестная ошибка");
  if (/chain not supported/i.test(detail)) return `${provider}: сеть ${network.name} не поддерживается этим источником`;
  if (/invalid account-history response/i.test(detail)) return `${provider}: источник вернул ответ без истории адреса для сети ${network.name}`;
  if (/HTTP 429/i.test(detail)) return `${provider}: временно превышен лимит запросов для сети ${network.name}`;
  if (/HTTP (401|403)/i.test(detail)) return `${provider}: для сети ${network.name} требуется собственный API-ключ`;
  if (/timed out/i.test(detail)) return `${provider}: источник сети ${network.name} не ответил вовремя`;
  return `${provider}: не удалось получить историю сети ${network.name} (${detail})`;
}

function normalizeRows({ rows, network, observedAddress, provenance, token = false }) {
  return rows.map((row, index) => {
    const txHash = row.hash || row.transactionHash || "";
    const decimals = token ? boundedInteger(row.tokenDecimal, 18, 0, 36) : network.decimals;
    const contractAddress = token ? row.contractAddress || null : null;
    const operationId = token ? `${contractAddress || "token"}:${row.logIndex ?? index}` : null;
    const gasFee = row.gasUsed && row.gasPrice
      ? (BigInt(numericString(row.gasUsed)) * BigInt(numericString(row.gasPrice))).toString()
      : "0";

    return createNormalizedTransaction({
      id: operationId ? `${network.key}:${txHash}:${operationId}` : `${network.key}:${txHash}`,
      txHash,
      operationId,
      network: publicNetwork(network),
      observedAddress,
      block: { number: row.blockNumber ? Number(row.blockNumber) : null },
      timestamp: row.timeStamp,
      status: token ? "confirmed" : statusFromEtherscanRow(row),
      operationType: token ? "token_transfer" : "native_transfer",
      fromAddresses: [row.from].filter(Boolean),
      toAddresses: [row.to].filter(Boolean),
      amount: {
        raw: numericString(row.value),
        decimals,
        symbol: token ? row.tokenSymbol || "TOKEN" : network.symbol,
        assetType: token ? "token" : "native",
        contractAddress,
      },
      fee: token ? null : { raw: gasFee, decimals: network.decimals, symbol: network.symbol },
      explorerUrl: `${network.explorerBaseUrl}/tx/${txHash}`,
      provenance,
      metadata: {
        methodId: row.methodId || null,
        functionName: row.functionName || null,
        nonce: row.nonce ?? null,
      },
    });
  });
}

function binplorerRows(payload, action) {
  if (payload?.error) throw new Error(payload.error.message || "Binplorer error");
  if (action === "txlist") {
    if (!Array.isArray(payload)) throw new Error("invalid account-history response");
    return payload.map((row) => ({
      hash: row.hash,
      from: row.from,
      to: row.to,
      value: numericString(row.rawValue),
      timeStamp: row.timestamp,
      txreceipt_status: row.success === false ? "0" : "1",
    }));
  }
  if (!Array.isArray(payload?.operations)) throw new Error("invalid account-history response");
  return payload.operations.map((row, index) => ({
    transactionHash: row.transactionHash,
    from: row.from,
    to: row.to,
    value: numericString(row.value),
    timeStamp: row.timestamp,
    tokenDecimal: row.tokenInfo?.decimals || "18",
    tokenSymbol: row.tokenInfo?.symbol || "TOKEN",
    contractAddress: row.tokenInfo?.address || "",
    logIndex: row.priority ?? index,
  }));
}

export class EvmAdapter extends NetworkAdapter {
  constructor(options) {
    super(options);
    this.routescanBaseUrl = String(options.routescanBaseUrl || DEFAULT_ROUTESCAN).replace(/\/$/, "");
    this.etherscanBaseUrl = String(options.etherscanBaseUrl || DEFAULT_ETHERSCAN).replace(/\/$/, "");
    this.etherscanApiKey = String(options.etherscanApiKey || "").trim();
    this.blockscoutBaseUrl = String(options.blockscoutBaseUrl || DEFAULT_BLOCKSCOUT[this.network.key] || "").replace(/\/$/, "");
    this.binplorerBaseUrl = String(options.binplorerBaseUrl || DEFAULT_BINPLORER[this.network.key] || "").replace(/\/$/, "");
    this.binplorerApiKey = String(options.binplorerApiKey || "freekey").trim() || "freekey";
  }

  validateAddress(address) {
    return validateAddressForNetwork(address, this.network.key);
  }

  hasHistoryProvider() {
    const declared = new Set(this.network.providers || []);
    return Boolean(
      (declared.has("Blockscout") && this.blockscoutBaseUrl) ||
      (declared.has("Binplorer") && this.binplorerBaseUrl) ||
      (declared.has("Routescan") && this.routescanBaseUrl) ||
      (declared.has("Etherscan") && this.etherscanApiKey)
    );
  }

  configuredProviderNames() {
    const names = [];
    const declared = new Set(this.network.providers || []);
    if (declared.has("Blockscout") && this.blockscoutBaseUrl) names.push("Blockscout");
    if (declared.has("Binplorer") && this.binplorerBaseUrl) names.push("Binplorer");
    if (declared.has("Routescan") && this.routescanBaseUrl) names.push("Routescan");
    if (declared.has("Etherscan") && this.etherscanApiKey) names.push("Etherscan");
    return names;
  }

  capabilities() {
    return {
      ...super.capabilities(),
      transactions: this.hasHistoryProvider(),
      historyProviders: this.configuredProviderNames(),
    };
  }

  async requestBinplorerRows({ action, address, page, limit }) {
    const maxRows = this.binplorerApiKey === "freekey" ? 100 : 1000;
    const fetchLimit = Math.min(maxRows, page * limit);
    const endpoint = action === "txlist" ? "getAddressTransactions" : "getAddressHistory";
    const params = new URLSearchParams({ apiKey: this.binplorerApiKey, limit: String(fetchLimit) });
    if (action === "txlist") params.set("showZeroValues", "true");
    const url = `${this.binplorerBaseUrl}/${endpoint}/${address}?${params}`;
    const payload = await fetchJsonWithRetry(url, {
      provider: "Binplorer",
      fetchImpl: this.fetchImpl,
      timeoutMs: 8_000,
      attempts: 1,
      baseDelayMs: 700,
    });
    const archived = await this.archive({
      provider: "Binplorer",
      operation: action,
      request: { url: redactApiKey(url), address, page, limit },
      response: payload,
    });
    const rows = binplorerRows(payload, action);
    const offset = (page - 1) * limit;
    return {
      rows: rows.slice(offset, offset + limit),
      provider: "Binplorer",
      archived,
      errors: [],
      hasMore: rows.length >= fetchLimit && fetchLimit < maxRows,
      limitations: [
        this.binplorerApiKey === "freekey"
          ? "BNB: бесплатный Binplorer показывает до 100 недавних операций и может ограничивать период 30 днями."
          : "BNB: персональный бесплатный Binplorer может ограничивать период истории одним годом.",
      ],
    };
  }

  async requestExplorerRows({ action, address, page, limit }) {
    const params = new URLSearchParams({
      module: "account",
      action,
      address,
      page: String(page),
      offset: String(limit),
      sort: "desc",
    });
    const declared = new Set(this.network.providers || []);
    const candidates = [];
    if (declared.has("Blockscout") && this.blockscoutBaseUrl) {
      candidates.push({ provider: "Blockscout", url: `${this.blockscoutBaseUrl}/api?${params}` });
    }
    if (declared.has("Etherscan") && this.etherscanApiKey) {
      const etherscanParams = new URLSearchParams(params);
      etherscanParams.set("chainid", String(this.network.chainId));
      etherscanParams.set("apikey", this.etherscanApiKey);
      candidates.push({ provider: "Etherscan", url: `${this.etherscanBaseUrl}/v2/api?${etherscanParams}` });
    }
    if (declared.has("Routescan") && this.routescanBaseUrl) {
      candidates.push({
        provider: "Routescan",
        url: `${this.routescanBaseUrl}/v2/network/mainnet/evm/${this.network.chainId}/etherscan/api?${params}`,
      });
    }

    const errors = [];
    for (const candidate of candidates) {
      try {
        const fetchOptions = {
          provider: candidate.provider,
          fetchImpl: this.fetchImpl,
          timeoutMs: 8_000,
          attempts: 1,
          baseDelayMs: 600,
        };
        const payload = candidate.provider === "Routescan"
          ? await fetchRoutescanQueued(candidate.url, fetchOptions)
          : await fetchJsonWithRetry(candidate.url, fetchOptions);
        const result = Array.isArray(payload.result) ? payload.result : [];
        const message = String(payload.message || payload.result || "");
        const noTransactions = /no transactions|no token transfers|no records/i.test(message);
        if (!Array.isArray(payload.result) && !noTransactions) {
          throw new Error(message || "invalid account-history response");
        }
        const archived = await this.archive({
          provider: candidate.provider,
          operation: action,
          request: { url: redactApiKey(candidate.url), address, page, limit },
          response: payload,
        });
        return {
          rows: result,
          provider: candidate.provider,
          archived,
          errors,
          hasMore: result.length >= limit,
          limitations: [],
        };
      } catch (error) {
        errors.push(readableProviderError(error, candidate.provider, this.network));
      }
    }
    throw new Error(errors.join(" | ") || `Для сети ${this.network.name} не подключён источник полной истории адреса`);
  }

  async requestRows(options) {
    const declared = new Set(this.network.providers || []);
    const errors = [];
    if (declared.has("Binplorer") && this.binplorerBaseUrl) {
      try {
        return await this.requestBinplorerRows(options);
      } catch (error) {
        errors.push(readableProviderError(error, "Binplorer", this.network));
      }
    }
    try {
      const result = await this.requestExplorerRows(options);
      return { ...result, errors: [...errors, ...(result.errors || [])] };
    } catch (error) {
      const detail = String(error?.message || error || "");
      throw new Error([...errors, detail].filter(Boolean).join(" | "));
    }
  }

  async listTransactions({ address, page = 1, limit = 25, from = null, to = null }) {
    if (!this.validateAddress(address)) {
      const error = new Error(`Неверный формат адреса для сети ${this.network.name}`);
      error.statusCode = 400;
      throw error;
    }
    if (!this.hasHistoryProvider()) {
      const error = new Error(`Для сети ${this.network.name} пока нет подключённого бесплатного источника истории адреса`);
      error.statusCode = 503;
      throw error;
    }
    const safePage = boundedInteger(page, 1, 1, 100_000);
    const safeLimit = boundedInteger(limit, 25, 1, 100);
    const [nativeResult, tokenResult] = await Promise.allSettled([
      this.requestRows({ action: "txlist", address, page: safePage, limit: safeLimit }),
      this.requestRows({ action: "tokentx", address, page: safePage, limit: safeLimit }),
    ]);
    const errors = [];
    const limitations = [];
    const items = [];
    const providers = new Set();

    if (nativeResult.status === "fulfilled") {
      providers.add(nativeResult.value.provider);
      items.push(...normalizeRows({
        rows: nativeResult.value.rows,
        network: this.network,
        observedAddress: address,
        provenance: {
          provider: nativeResult.value.provider,
          retrievedAt: nativeResult.value.archived.retrievedAt,
          rawResponseId: nativeResult.value.archived.id,
          rawResponseHash: nativeResult.value.archived.contentHash,
        },
      }));
      errors.push(...nativeResult.value.errors);
      limitations.push(...(nativeResult.value.limitations || []));
    } else {
      errors.push(nativeResult.reason?.message || "Не удалось получить обычные переводы");
    }

    if (tokenResult.status === "fulfilled") {
      providers.add(tokenResult.value.provider);
      items.push(...normalizeRows({
        rows: tokenResult.value.rows,
        network: this.network,
        observedAddress: address,
        provenance: {
          provider: tokenResult.value.provider,
          retrievedAt: tokenResult.value.archived.retrievedAt,
          rawResponseId: tokenResult.value.archived.id,
          rawResponseHash: tokenResult.value.archived.contentHash,
        },
        token: true,
      }));
      errors.push(...tokenResult.value.errors);
      limitations.push(...(tokenResult.value.limitations || []));
    } else {
      errors.push(tokenResult.reason?.message || "Не удалось получить переводы токенов");
    }

    if (nativeResult.status === "rejected" && tokenResult.status === "rejected") {
      throw new Error([...new Set(errors)].join(" | "));
    }

    const minTime = from ? Date.parse(from) : null;
    const maxTime = to ? Date.parse(to) : null;
    const unique = items
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
      .filter((item) => !Number.isFinite(minTime) || (item.timestamp && Date.parse(item.timestamp) >= minTime))
      .filter((item) => !Number.isFinite(maxTime) || (item.timestamp && Date.parse(item.timestamp) <= maxTime))
      .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
      .slice(0, safeLimit);
    const hasMore = [nativeResult, tokenResult]
      .filter((result) => result.status === "fulfilled")
      .some((result) => result.value.hasMore);
    const uniqueErrors = [...new Set(errors)];
    const uniqueLimitations = [...new Set(limitations)];

    return {
      items: unique,
      pagination: { page: safePage, limit: safeLimit, cursor: null, hasMore },
      providers: [...providers],
      errors: uniqueErrors,
      limitations: uniqueLimitations,
      completeness: uniqueErrors.length || uniqueLimitations.length ? "partial" : hasMore ? "paginated" : "complete_page",
    };
  }
}
