import { BitcoinAdapter } from "../adapters/bitcoin-adapter.mjs";
import { EvmAdapter } from "../adapters/evm-adapter.mjs";
import { TronAdapter } from "../adapters/tron-adapter.mjs";
import { RawResponseStore } from "../evidence/raw-response-store.mjs";
import { detectNetworksByFormat, getNetwork, listNetworks, publicNetwork, validateAddressForNetwork } from "../networks/registry.mjs";
import { analyzeAddressConnections } from "./address-connection-service.mjs";

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TransactionService {
  constructor({ dataDir, fetchImpl = fetch, providerConfig = {} }) {
    this.rawStore = new RawResponseStore({ dataDir });
    this.adapters = new Map();
    for (const network of listNetworks()) {
      const common = { network, rawStore: this.rawStore, fetchImpl };
      if (network.family === "evm") {
        this.adapters.set(network.key, new EvmAdapter({
          ...common,
          routescanBaseUrl: providerConfig.routescanBaseUrl,
          etherscanBaseUrl: providerConfig.etherscanBaseUrl,
          etherscanApiKey: providerConfig.etherscanApiKey,
          blockscoutBaseUrl: providerConfig.blockscout?.[network.key],
          binplorerBaseUrl: providerConfig.binplorer?.endpoints?.[network.key],
          binplorerApiKey: providerConfig.binplorer?.apiKey,
        }));
      } else if (network.family === "tron") {
        this.adapters.set(network.key, new TronAdapter({ ...common, baseUrl: providerConfig.tronBaseUrl }));
      } else if (network.family === "utxo") {
        this.adapters.set(network.key, new BitcoinAdapter({
          ...common,
          mempoolBaseUrl: providerConfig.mempoolBaseUrl,
          blockstreamBaseUrl: providerConfig.blockstreamBaseUrl,
        }));
      }
    }
  }

  networks() {
    return listNetworks().map((network) => ({
      ...network,
      capabilities: this.adapters.get(network.key)?.capabilities() || {},
      dataPolicy: "live_or_explicit_error",
    }));
  }

  async detectAddress({ address, probe = false }) {
    const candidates = detectNetworksByFormat(address);
    const result = {
      address,
      validFormat: candidates.length > 0,
      ambiguous: candidates.length > 1,
      candidates: candidates.map((network) => ({ network: publicNetwork(network), activity: "not_checked" })),
      basis: "address_format",
      warning: candidates.length > 1
        ? "Один EVM-адрес имеет одинаковый формат во многих сетях. Сеть нельзя определить только по виду адреса."
        : null,
    };
    if (!probe || !candidates.length) return result;

    result.basis = "address_format_and_live_activity_probe";
    result.candidates = await Promise.all(candidates.map(async (network) => {
      const adapter = this.adapters.get(network.key);
      if (network.family === "evm" && !adapter?.hasHistoryProvider()) {
        return {
          network: publicNetwork(network),
          activity: "source_unavailable",
          error: `Для сети ${network.name} не подключён источник истории`,
        };
      }
      try {
        const data = await this.listTransactions({ address, networkKey: network.key, limit: 1 });
        return {
          network: publicNetwork(network),
          activity: data.items.length ? "found" : "not_found_on_first_page",
          provider: data.dataQuality.sourceProviders[0] || null,
        };
      } catch (error) {
        return { network: publicNetwork(network), activity: "unknown", error: error.message };
      }
    }));
    result.ambiguous = result.candidates.filter((candidate) => candidate.activity === "found").length !== 1;
    return result;
  }

  async listTransactions({ address, networkKey, page = 1, limit = 25, cursor = "", from = null, to = null, requestProfile = "default" }) {
    const key = String(networkKey || "").trim().toUpperCase();
    if (key === "ALL") {
      return this.listAllEvmTransactions({ address, page, limit, from, to });
    }
    const network = getNetwork(key);
    if (!network) {
      const error = new Error(`Сеть не поддерживается: ${key || "не указана"}`);
      error.statusCode = 400;
      throw error;
    }
    if (!validateAddressForNetwork(address, key)) {
      const error = new Error(`Формат адреса не соответствует сети ${network.name}`);
      error.statusCode = 400;
      throw error;
    }
    const adapter = this.adapters.get(key);
    if (!adapter) {
      const error = new Error(`Для сети ${network.name} не настроен модуль загрузки`);
      error.statusCode = 501;
      throw error;
    }
    const retrievedAt = new Date().toISOString();
    const result = await adapter.listTransactions({ address, page, limit, cursor, from, to, requestProfile });
    const warnings = [];
    if (result.pagination.hasMore) warnings.push("Доступны следующие страницы транзакций.");
    if (result.errors.length) warnings.push("Один из источников не ответил; история может быть неполной.");
    warnings.push(...(result.limitations || []));
    if (network.family === "utxo") {
      warnings.push("Выходы Bitcoin сохранены как факты. Принадлежность сдачи не утверждается без дополнительных доказательств.");
    }
    return {
      schemaVersion: "2.0",
      address,
      network: publicNetwork(network),
      request: { page: Number(page || 1), limit: Number(limit || 25), cursor: cursor || null, from, to },
      items: result.items,
      pagination: result.pagination,
      dataQuality: {
        dataMode: "live",
        sourceProviders: result.providers,
        retrievedAt,
        completeness: result.completeness,
        rawEvidenceStored: true,
        errors: result.errors,
        warnings,
      },
    };
  }

  async analyzeAddressConnections({ addresses, networkKey, depth = 2, limitPerAddress = 50, from = null, to = null }) {
    const key = String(networkKey || "").trim().toUpperCase();
    const network = getNetwork(key);
    if (!network || key === "ALL") {
      const error = new Error("Для массового анализа выберите одну конкретную сеть.");
      error.statusCode = 400;
      throw error;
    }
    const cleanAddresses = Array.isArray(addresses) ? addresses.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const invalid = cleanAddresses.filter((address) => !validateAddressForNetwork(address, key));
    if (invalid.length) {
      const error = new Error(`Формат ${invalid.length} адресов не соответствует сети ${network.name}: ${invalid.slice(0, 3).join(", ")}`);
      error.statusCode = 400;
      throw error;
    }
    return analyzeAddressConnections({
      addresses: cleanAddresses,
      network: publicNetwork(network),
      depth,
      limitPerAddress,
      from,
      to,
      loadTransactions: ({ address, limit, from: rangeFrom, to: rangeTo }) => this.listTransactions({
        address,
        networkKey: key,
        page: 1,
        limit,
        from: rangeFrom,
        to: rangeTo,
        requestProfile: "batch",
      }),
    });
  }

  async listAllEvmTransactions({ address, page = 1, limit = 25, from = null, to = null }) {
    if (!validateAddressForNetwork(address, "ETH")) {
      const error = new Error("Формат адреса не соответствует EVM-сетям");
      error.statusCode = 400;
      throw error;
    }
    const safeLimit = Math.min(100, Math.max(1, Number(limit || 25)));
    const evmNetworks = listNetworks().filter((network) => network.family === "evm");
    const runnable = evmNetworks.filter((network) => this.adapters.get(network.key)?.hasHistoryProvider());
    const withoutSource = evmNetworks.filter((network) => !this.adapters.get(network.key)?.hasHistoryProvider());
    const results = await mapWithConcurrency(runnable, runnable.length, async (network) => {
      try {
        const result = await this.adapters.get(network.key).listTransactions({ address, page, limit: safeLimit, from, to });
        return { status: "fulfilled", network, result };
      } catch (error) {
        return { status: "rejected", network, error };
      }
    });
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    const items = fulfilled
      .flatMap(({ result }) => result.items)
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
      .slice(0, safeLimit);
    const errors = [
      ...fulfilled.flatMap(({ network, result }) => result.errors.map((error) => `${network.name}: ${error}`)),
      ...failed.map(({ network, error }) => `${network.name}: ${error?.message || "источник не ответил"}`),
    ];
    const limitations = [...new Set(fulfilled.flatMap(({ result }) => result.limitations || []))];
    const hasMore = fulfilled.some(({ result }) => result.pagination.hasMore);
    const networkChecks = [
      ...fulfilled.map(({ network, result }) => ({
        networkKey: network.key,
        networkName: network.name,
        status: result.errors.length || result.limitations?.length ? "partial" : "checked",
        transactionCount: result.items.length,
        providers: result.providers,
        note: result.limitations?.join(" ") || result.errors.join(" ") || "",
      })),
      ...failed.map(({ network, error }) => ({
        networkKey: network.key,
        networkName: network.name,
        status: "unavailable",
        transactionCount: null,
        providers: this.adapters.get(network.key)?.configuredProviderNames() || [],
        note: error?.message || "Источник не ответил",
      })),
      ...withoutSource.map((network) => ({
        networkKey: network.key,
        networkName: network.name,
        status: "no_source",
        transactionCount: null,
        providers: [],
        note: "Нет подключённого бесплатного источника истории адреса",
      })),
    ];
    const scannedNetworks = fulfilled.map(({ network }) => network.name);
    const skippedNetworks = [...failed.map(({ network }) => network.name), ...withoutSource.map((network) => network.name)];
    return {
      schemaVersion: "2.0",
      address,
      network: {
        key: "ALL",
        name: "Все доступные EVM-сети",
        family: "evm",
        chainId: null,
        symbol: null,
        decimals: 18,
        explorerBaseUrl: null,
      },
      request: { page: Number(page || 1), limit: safeLimit, cursor: null, from, to },
      items,
      pagination: { page: Number(page || 1), limit: safeLimit, cursor: null, hasMore },
      scannedNetworks,
      skippedNetworks,
      dataQuality: {
        dataMode: fulfilled.length ? "live" : "unavailable",
        sourceProviders: [...new Set(fulfilled.flatMap(({ result }) => result.providers))],
        retrievedAt: new Date().toISOString(),
        completeness: errors.length || limitations.length || skippedNetworks.length ? "partial" : hasMore ? "paginated" : "complete_page",
        rawEvidenceStored: true,
        errors,
        networkChecks,
        warnings: [
          `Один и тот же адрес независимо проверен в ${fulfilled.length} EVM-сетях с доступными источниками.`,
          ...limitations,
          ...(hasMore ? ["Доступны следующие страницы транзакций."] : []),
          ...(errors.length ? ["Часть источников не ответила; результат нельзя считать полной историей."] : []),
          ...(withoutSource.length ? [`Для ${withoutSource.length} сетей бесплатный источник истории пока не подключён.`] : []),
        ],
      },
    };
  }
}
