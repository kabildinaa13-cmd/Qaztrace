import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { createApiV2 } from "./v2/router.mjs";
import { lookupPublicAttribution } from "./public-attribution.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(__dirname, "data");
const walletProfilesFile = join(dataDir, "wallet_profiles.json");
const watchlistRulesFile = join(dataDir, "watchlist_rules.json");
const alertEventsFile = join(dataDir, "alert_events.json");
const watchStateFile = join(dataDir, "watch_state.json");
const entityLabelsFile = join(dataDir, "entity_labels.json");
const investigationCasesFile = join(dataDir, "investigation_cases.json");
const mixerChainScansFile = join(dataDir, "mixer_chain_scans.json");
const auditEventsFile = join(dataDir, "audit_events.json");
const usersFile = join(dataDir, "users.json");
const demoProtectedStoreFiles = new Set([
  walletProfilesFile,
  watchlistRulesFile,
  alertEventsFile,
  entityLabelsFile,
  investigationCasesFile,
  mixerChainScansFile,
]);

await loadEnvFile();

// Safe by default: credentials are ignored unless the owner explicitly enables them.
// This prevents an old or borrowed key left in .env from being used accidentally.
const credentialedProvidersEnabled = String(process.env.ALLOW_CREDENTIALLED_PROVIDERS || "false").toLowerCase() === "true";

function providerCredential(...names) {
  if (!credentialedProvidersEnabled) return "";
  return names.map((name) => process.env[name] || "").find(Boolean) || "";
}

const defaultDbConfig = {
  protocol: process.env.DATABASE_PROTOCOL || "postgres",
  user: process.env.POSTGRES_USER || "chainsentinel",
  password: process.env.POSTGRES_PASSWORD || "chainsentinel",
  host: process.env.POSTGRES_HOST || "localhost",
  port: process.env.POSTGRES_PORT || "5432",
  name: process.env.POSTGRES_DB || "chainsentinel",
};
const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const databaseUrl =
  process.env.DATABASE_URL ||
  `${defaultDbConfig.protocol}://${defaultDbConfig.user}:${defaultDbConfig.password}@${defaultDbConfig.host}:${defaultDbConfig.port}/${defaultDbConfig.name}`;
const storageDriver = String(process.env.STORAGE_DRIVER || "postgres").trim().toLowerCase();
const usePostgres = storageDriver !== "json";
const pollIntervalMs = Number(process.env.WATCHLIST_POLL_INTERVAL_MS || 60_000);
const tronDustMinSun = 1_000_000;
const etherscanRequestDelayMs = Number(process.env.ETHERSCAN_REQUEST_DELAY_MS || 450);
const etherscanRateLimitRetryMs = Number(process.env.ETHERSCAN_RATE_LIMIT_RETRY_MS || 1_500);
const routescanRequestDelayMs = Number(process.env.ROUTESCAN_REQUEST_DELAY_MS || 650);
const arkhamGraphEnrichmentLimit = Number(process.env.ARKHAM_GRAPH_ENRICHMENT_LIMIT || 24);
const riskCacheTtlMs = Number(process.env.RISK_CACHE_TTL_MS || 15 * 60 * 1000);
const riskModelVersion = "v2-ofac-floor-80";
const transactionCacheTtlMs = Number(process.env.TRANSACTION_CACHE_TTL_MS || 60 * 1000);
const liveProfileCacheTtlMs = Number(process.env.LIVE_PROFILE_CACHE_TTL_MS || 2 * 60 * 1000);
const tokenBalanceCacheTtlMs = Number(process.env.TOKEN_BALANCE_CACHE_TTL_MS || 30 * 60 * 1000);
const nftExposureCacheTtlMs = Number(process.env.NFT_EXPOSURE_CACHE_TTL_MS || 60 * 60 * 1000);
const arkhamCacheTtlMs = Number(process.env.ARKHAM_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const graphCacheTtlMs = Number(process.env.GRAPH_CACHE_TTL_MS || 10 * 60 * 1000);
const authTokenTtlMs = Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const registrationEnabled = String(process.env.REGISTRATION_ENABLED || "false").toLowerCase() === "true";
const configuredAdminUsernames = new Set(
  String(process.env.ADMIN_USERNAMES || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const loginRateLimit = Math.max(3, Math.min(30, Number(process.env.LOGIN_RATE_LIMIT || 8)));
const registerRateLimit = Math.max(1, Math.min(20, Number(process.env.REGISTER_RATE_LIMIT || 3)));
const authRateWindowMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000)));
const scryptAsync = promisify(scrypt);
const authRateBuckets = new Map();
const storeMutationQueues = new Map();
const { Pool } = pg;
const pool = usePostgres ? new Pool({ connectionString: databaseUrl }) : null;
let etherscanQueue = Promise.resolve();
let lastEtherscanRequestAt = 0;
let routescanQueue = Promise.resolve();
let lastRoutescanRequestAt = 0;
let tronRequestQueue = Promise.resolve();
let lastTronRequestAt = 0;
const tronResponseCache = new Map();
const arkhamNodeCache = new Map();
const serviceProtocol = process.env.SERVICE_URL_PROTOCOL || "https";
const publicWebProtocol = process.env.PUBLIC_WEB_PROTOCOL || "https";
const trongridHost = process.env.TRONGRID_HOST || "api.trongrid.io";
const tronPublicRequestIntervalMs = Math.max(250, Number(process.env.TRON_PUBLIC_REQUEST_INTERVAL_MS || 900));
const tronPublicMaxRetries = Math.max(1, Math.min(6, Number(process.env.TRON_PUBLIC_MAX_RETRIES || 4)));
const tronPublicRetryBaseMs = Math.max(500, Number(process.env.TRON_PUBLIC_RETRY_BASE_MS || 1_500));
const tronPublicCacheTtlMs = Math.max(30_000, Number(process.env.TRON_PUBLIC_CACHE_TTL_MS || 5 * 60 * 1000));
const tronTraceMaxNodes = Math.max(40, Math.min(500, Number(process.env.TRON_TRACE_MAX_NODES || 240)));
const requestedOllamaBaseUrl = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const ollamaBaseUrl = (() => {
  try {
    const parsed = new URL(requestedOllamaBaseUrl);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
      ? requestedOllamaBaseUrl
      : "http://127.0.0.1:11434";
  } catch {
    return "http://127.0.0.1:11434";
  }
})();
const ollamaModel = String(process.env.OLLAMA_MODEL || "qwen3:1.7b").trim();
const ollamaTimeoutMs = Math.max(5_000, Math.min(120_000, Number(process.env.OLLAMA_TIMEOUT_MS || 45_000)));
const arkhamHost = process.env.ARKHAM_HOST || "api.arkm.com";
const alchemyHostSuffix = process.env.ALCHEMY_HOST_SUFFIX || "g.alchemy.com";
const alchemyPricesHost = process.env.ALCHEMY_PRICES_HOST || `api.${alchemyHostSuffix}`;
const routescanHost = process.env.ROUTESCAN_HOST || "api.routescan.io";
const etherscanApiHost = process.env.ETHERSCAN_API_HOST || "api.etherscan.io";
const etherscanExplorerHost = process.env.ETHERSCAN_EXPLORER_HOST || "etherscan.io";
const tronscanHost = process.env.TRONSCAN_HOST || "tronscan.org";
const tronscanApiBaseUrl = (process.env.TRONSCAN_API_BASE_URL || "https://apilist.tronscanapi.com").replace(/\/$/, "");
const mempoolApiBase = (process.env.MEMPOOL_API_BASE || "https://mempool.space/api").replace(/\/$/, "");
const mempoolExplorerBase = (process.env.MEMPOOL_EXPLORER_BASE || "https://mempool.space").replace(/\/$/, "");
const blockstreamApiBase = (process.env.BLOCKSTREAM_API_BASE || "https://blockstream.info/api").replace(/\/$/, "");
const blockstreamExplorerBase = (process.env.BLOCKSTREAM_EXPLORER_BASE || "https://blockstream.info").replace(/\/$/, "");
const blockchainApiBase = (process.env.BLOCKCHAIN_API_BASE || "https://blockchain.info").replace(/\/$/, "");
const blockchainExplorerBase = (process.env.BLOCKCHAIN_EXPLORER_BASE || "https://www.blockchain.com/explorer").replace(/\/$/, "");
const telegramApiHost = process.env.TELEGRAM_API_HOST || "api.telegram.org";
const ofacSlsBaseUrl = (process.env.OFAC_SLS_BASE_URL || "https://sanctionslistservice.ofac.treas.gov").replace(/\/$/, "");
const ofacSlsFiles = String(process.env.OFAC_SLS_FILES || "SDN_ENHANCED.XML,CONS_ENHANCED.XML")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const requestBaseProtocol = process.env.REQUEST_BASE_PROTOCOL || "http";
const requestBodyLimitBytes = Math.max(16_384, Math.min(10_485_760, Number(process.env.REQUEST_BODY_LIMIT_BYTES || 2_097_152)));
const corsAllowedOrigins = new Set(
  String(process.env.CORS_ALLOWED_ORIGINS || "http://localhost:5174,http://127.0.0.1:5174")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
async function loadOrCreateAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const secretFile = join(dataDir, ".auth_secret");
  try {
    const existing = (await readFile(secretFile, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First local start: create a server-only persistent secret below.
  }
  const generated = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(secretFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  return generated;
}

const authSecret = await loadOrCreateAuthSecret();
const memoryTransactionCache = new Map();
const memoryRiskCache = new Map();
const memoryApiResponseCache = new Map();
const transactionCacheProviderName = usePostgres ? "PostgreSQL transaction cache" : "Memory transaction cache";
const transactionCacheDescription = usePostgres
  ? "cached normalized wallet_transactions"
  : "in-memory normalized wallet_transactions";
const storeCollections = new Map([
  [usersFile, { table: "users", keyField: "id" }],
  [walletProfilesFile, { table: "wallet_profiles", keyField: "scopedKey" }],
  [watchlistRulesFile, { table: "watchlist_rules", keyField: "id" }],
  [alertEventsFile, { table: "alert_events", keyField: "id" }],
  [watchStateFile, { table: "watch_state", keyField: "stateKey" }],
  [entityLabelsFile, { table: "entity_labels", keyField: "id" }],
  [investigationCasesFile, { table: "investigation_cases", keyField: "id" }],
  [mixerChainScansFile, { table: "mixer_chain_scans", keyField: "id" }],
  [auditEventsFile, { table: "audit_events", keyField: "id" }],
]);
const storeTables = new Set([...storeCollections.values()].map((config) => config.table));

function storeTableName(config) {
  if (!storeTables.has(config.table)) {
    throw new Error(`Unsafe store table: ${config.table}`);
  }

  return config.table;
}

function storeCreateTableSql(config) {
  return (
    "CREATE TABLE IF NOT EXISTS " +
    storeTableName(config) +
    " (" +
    "item_key text PRIMARY KEY, " +
    "sort_order integer NOT NULL DEFAULT 0, " +
    "payload jsonb NOT NULL, " +
    "created_at timestamptz NOT NULL DEFAULT now(), " +
    "updated_at timestamptz NOT NULL DEFAULT now()" +
    ")"
  );
}

function storePayloadIndexSql(config) {
  const table = storeTableName(config);
  return "CREATE INDEX IF NOT EXISTS " + table + "_payload_gin ON " + table + " USING gin (payload)";
}

function storeReadSql(config) {
  return "SELECT payload FROM " + storeTableName(config) + " ORDER BY sort_order ASC, updated_at DESC";
}

function storeDeleteSql(config) {
  return "DELETE FROM " + storeTableName(config);
}

function storeInsertSql(config) {
  return (
    "INSERT INTO " +
    storeTableName(config) +
    " (item_key, sort_order, payload, created_at, updated_at) " +
    "VALUES ($1, $2, $3::jsonb, now(), now()) " +
    "ON CONFLICT (item_key) " +
    "DO UPDATE SET sort_order = EXCLUDED.sort_order, payload = EXCLUDED.payload, updated_at = now()"
  );
}

function storeCountSql(config) {
  return "SELECT COUNT(*)::int AS count FROM " + storeTableName(config);
}

const publicRpcEndpoints = {
  ETH: process.env.PUBLIC_RPC_ETH_URL || "https://ethereum-rpc.publicnode.com",
  ARB: process.env.PUBLIC_RPC_ARB_URL || "https://arb1.arbitrum.io/rpc",
  BASE: process.env.PUBLIC_RPC_BASE_URL || "https://mainnet.base.org",
  BNB: process.env.PUBLIC_RPC_BNB_URL || "https://bsc-dataseed.binance.org",
  OP: process.env.PUBLIC_RPC_OP_URL || "https://mainnet.optimism.io",
  POLYGON: process.env.PUBLIC_RPC_POLYGON_URL || "https://polygon-rpc.com",
};

const evmNetworks = [
  ["Ethereum", "ETH", "ETH", "1"],
  ["Arbitrum", "ARB", "ETH", "42161"],
  ["Avalanche C-Chain", "AVAX", "AVAX", "43114"],
  ["Base", "BASE", "ETH", "8453"],
  ["Blast", "BLAST", "ETH", "81457"],
  ["BNB Chain", "BNB", "BNB", "56"],
  ["Celo", "CELO", "CELO", "42220"],
  ["Linea", "LINEA", "ETH", "59144"],
  ["Mantle", "MANTLE", "MNT", "5000"],
  ["Optimism", "OP", "ETH", "10"],
  ["Polygon PoS", "POLYGON", "POL", "137"],
  ["Scroll", "SCROLL", "ETH", "534352"],
  ["Unichain", "UNICHAIN", "ETH", "130"],
  ["ZKsync Era", "ZKSYNC", "ETH", "324"],
].map(([name, key, symbol, chainId]) => ({ name, key, symbol, chainId }));
const alchemyNetworkSlugs = {
  ETH: "eth-mainnet",
  ARB: "arb-mainnet",
  AVAX: "avax-mainnet",
  BASE: "base-mainnet",
  BLAST: "blast-mainnet",
  BNB: "bnb-mainnet",
  LINEA: "linea-mainnet",
  MANTLE: "mantle-mainnet",
  OP: "opt-mainnet",
  POLYGON: "polygon-mainnet",
  SCROLL: "scroll-mainnet",
  UNICHAIN: "unichain-mainnet",
  ZKSYNC: "zksync-mainnet",
};
const blockscoutProtocol = process.env.BLOCKSCOUT_PROTOCOL || "https";
const blockscoutHosts = {
  ETH: process.env.BLOCKSCOUT_ETH_HOST || "eth.blockscout.com",
  ARB: process.env.BLOCKSCOUT_ARB_HOST || "arbitrum.blockscout.com",
  BASE: process.env.BLOCKSCOUT_BASE_HOST || "base.blockscout.com",
  CELO: process.env.BLOCKSCOUT_CELO_HOST || "celo.blockscout.com",
  HEMI: process.env.BLOCKSCOUT_HEMI_HOST || "explorer.hemi.xyz",
  LINEA: process.env.BLOCKSCOUT_LINEA_HOST || "explorer.linea.build",
  MEGAETH: process.env.BLOCKSCOUT_MEGAETH_HOST || "megaeth.blockscout.com",
  OP: process.env.BLOCKSCOUT_OP_HOST || "explorer.optimism.io",
  POLYGON: process.env.BLOCKSCOUT_POLYGON_HOST || "polygon.blockscout.com",
  SCROLL: process.env.BLOCKSCOUT_SCROLL_HOST || "scroll.blockscout.com",
  UNICHAIN: process.env.BLOCKSCOUT_UNICHAIN_HOST || "unichain.blockscout.com",
  ZKSYNC: process.env.BLOCKSCOUT_ZKSYNC_HOST || "zksync.blockscout.com",
  GNOSIS: process.env.BLOCKSCOUT_GNOSIS_HOST || "gnosis.blockscout.com",
};
const evmExplorerHosts = {
  ETH: process.env.EXPLORER_ETH_HOST || etherscanExplorerHost,
  ARB: process.env.EXPLORER_ARB_HOST || "arbiscan.io",
  AVAX: process.env.EXPLORER_AVAX_HOST || "snowtrace.io",
  BASE: process.env.EXPLORER_BASE_HOST || "basescan.org",
  BLAST: process.env.EXPLORER_BLAST_HOST || "blastscan.io",
  BNB: process.env.EXPLORER_BNB_HOST || "bscscan.com",
  CELO: process.env.EXPLORER_CELO_HOST || "celoscan.io",
  LINEA: process.env.EXPLORER_LINEA_HOST || "lineascan.build",
  MANTLE: process.env.EXPLORER_MANTLE_HOST || "explorer.mantle.xyz",
  OP: process.env.EXPLORER_OP_HOST || "optimistic.etherscan.io",
  POLYGON: process.env.EXPLORER_POLYGON_HOST || "polygonscan.com",
  SCROLL: process.env.EXPLORER_SCROLL_HOST || "scrollscan.com",
  UNICHAIN: process.env.EXPLORER_UNICHAIN_HOST || "uniscan.xyz",
  ZKSYNC: process.env.EXPLORER_ZKSYNC_HOST || "era.zksync.network",
};
const alchemyTokenMetadataCache = new Map();
const alchemyTransferCategories = ["external", "internal", "erc20"];
const priceCache = new Map();
const priceCacheTtlMs = Number(process.env.PRICE_CACHE_TTL_MS || 5 * 60 * 1000);
const stablecoinSymbols = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USD1"]);
const nativePriceIds = {
  ETH: "coingecko:ethereum",
  ARB: "coingecko:ethereum",
  BASE: "coingecko:ethereum",
  BLAST: "coingecko:ethereum",
  LINEA: "coingecko:ethereum",
  OP: "coingecko:ethereum",
  SCROLL: "coingecko:ethereum",
  UNICHAIN: "coingecko:ethereum",
  ZKSYNC: "coingecko:ethereum",
  AVAX: "coingecko:avalanche-2",
  BNB: "coingecko:binancecoin",
  CELO: "coingecko:celo",
  MANTLE: "coingecko:mantle",
  POLYGON: "coingecko:polygon-ecosystem-token",
  TRX: "coingecko:tron",
  BTC: "coingecko:bitcoin",
};
const logger = {
  info(...args) {
    if (process.env.LOG_LEVEL === "debug") {
      process.stdout.write(`${args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ")}\n`);
    }
  },
  error(...args) {
    console.error(...args);
  },
};

async function loadEnvFile() {
  try {
    const raw = await readFile(join(__dirname, "..", ".env"), "utf8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const [key, ...valueParts] = trimmed.split("=");

      // The local .env file may intentionally contain a later override (for example,
      // ALLOW_CREDENTIALLED_PROVIDERS=false followed by true). Respect that explicit
      // final choice so provider credentials can be enabled by the owner.
      if (key === "ALLOW_CREDENTIALLED_PROVIDERS" || !process.env[key]) {
        process.env[key] = valueParts.join("=");
      }
    }
  } catch {
    // .env is optional.
  }
}

async function ensureStore() {
  if (!usePostgres) {
    await mkdir(dataDir, { recursive: true });

    for (const file of storeCollections.keys()) {
      try {
        await readFile(file, "utf8");
      } catch {
        await writeFile(file, "[]\n", "utf8");
      }
    }

    return;
  }

  for (const config of storeCollections.values()) {
    await pool.query(storeCreateTableSql(config));
    await pool.query(storePayloadIndexSql(config));
  }

  for (const file of storeCollections.keys()) {
    await migrateJsonFileIfEmpty(file);
  }

  await ensureTransactionCache();
  await ensureRiskCache();
  await ensureApiResponseCache();
  await ensureProviderTelemetry();
}

async function ensureTransactionCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      observed_address text NOT NULL,
      network_key text NOT NULL,
      tx_hash text NOT NULL,
      tx_timestamp bigint,
      block_number bigint,
      payload jsonb NOT NULL,
      provider text,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (observed_address, network_key, tx_hash)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wallet_transactions_address_time_idx
    ON wallet_transactions (observed_address, network_key, tx_timestamp DESC NULLS LAST)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wallet_transactions_payload_gin
    ON wallet_transactions
    USING gin (payload)
  `);
}

async function ensureRiskCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_risk_cache (
      observed_address text NOT NULL,
      network_key text NOT NULL,
      mode text NOT NULL,
      payload jsonb NOT NULL,
      calculated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (observed_address, network_key, mode)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wallet_risk_cache_calculated_idx
    ON wallet_risk_cache (calculated_at DESC)
  `);
}

async function ensureApiResponseCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_response_cache (
      cache_key text PRIMARY KEY,
      payload jsonb NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS api_response_cache_fetched_idx
    ON api_response_cache (fetched_at DESC)
  `);
}

async function ensureProviderTelemetry() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_call_events (
      id bigserial PRIMARY KEY,
      provider text NOT NULL,
      operation text NOT NULL,
      ok boolean NOT NULL,
      status integer,
      duration_ms integer NOT NULL,
      message text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS provider_call_events_provider_time_idx
    ON provider_call_events (provider, created_at DESC)
  `);
}

async function readJson(file) {
  if (!usePostgres) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw || "[]");
      const items = Array.isArray(parsed) ? parsed : [];
      return demoProtectedStoreFiles.has(file) ? items.filter((item) => !isDemoDataRecord(item)) : items;
    } catch {
      return [];
    }
  }

  const config = storeConfig(file);
  const result = await pool.query(storeReadSql(config));

  const items = result.rows.map((row) => row.payload);
  return demoProtectedStoreFiles.has(file) ? items.filter((item) => !isDemoDataRecord(item)) : items;
}

async function writeJson(file, value) {
  const rawItems = Array.isArray(value) ? value : [];
  const sanitizedItems = demoProtectedStoreFiles.has(file)
    ? rawItems.filter((item) => !isDemoDataRecord(item))
    : rawItems;

  if (!usePostgres) {
    await mkdir(dirname(file), { recursive: true });
    const tempFile = join(
      dirname(file),
      `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    await writeFile(tempFile, `${JSON.stringify(sanitizedItems, null, 2)}\n`, "utf8");
    await rename(tempFile, file);
    return;
  }

  const config = storeConfig(file);
  const items = sanitizedItems;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(storeDeleteSql(config));

    for (const [index, item] of items.entries()) {
      const itemKey = item?.[config.keyField] || item?.id || item?.address || `${config.table}_${index}`;

      await client.query(
        storeInsertSql(config),
        [String(itemKey), index, JSON.stringify(item)]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withStoreMutationLock(file, task) {
  const prior = storeMutationQueues.get(file) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => gate);
  storeMutationQueues.set(file, queued);
  await prior;

  try {
    return await task();
  } finally {
    release();
    if (storeMutationQueues.get(file) === queued) {
      storeMutationQueues.delete(file);
    }
  }
}

async function mutateStore(file, mutator) {
  return withStoreMutationLock(file, async () => {
    const current = await readJson(file);
    const { items, result } = await mutator(current);
    if (!Array.isArray(items)) {
      throw new Error("Store mutation must return an items array");
    }
    await writeJson(file, items);
    return result;
  });
}

function storeConfig(file) {
  const config = storeCollections.get(file);

  if (!config) {
    throw new Error(`Unknown store collection: ${file}`);
  }

  return config;
}

async function migrateJsonFileIfEmpty(file) {
  const config = storeConfig(file);
  const countResult = await pool.query(storeCountSql(config));

  if (countResult.rows[0]?.count > 0) {
    return;
  }

  let items = [];

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw || "[]");
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = [];
  }

  if (items.length) {
    await writeJson(file, items);
  }
}

async function readProfiles() {
  const profiles = await readJson(walletProfilesFile);
  return profiles.map((profile) => normalizeScopedItem(profile, profile.profileId));
}

async function writeProfiles(profiles) {
  await writeJson(walletProfilesFile, profiles.map((profile) => normalizeWalletProfile(profile, profile.profileId)));
}

function normalizeProfileId(value) {
  const normalized = String(value || "default").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  return normalized || "default";
}

function profileIdFromSearch(url) {
  return normalizeProfileId(url.searchParams.get("profileId") || "default");
}

function scopedKey(profileId, key) {
  return `${normalizeProfileId(profileId)}:${String(key || "").toLowerCase()}`;
}

function normalizeScopedItem(item, profileId = "default") {
  return {
    ...item,
    profileId: normalizeProfileId(item?.profileId || profileId),
  };
}

function normalizeWalletProfile(profile, profileId = "default") {
  const normalized = normalizeScopedItem(profile, profileId);
  return {
    ...normalized,
    scopedKey: scopedKey(normalized.profileId, normalized.address),
  };
}

function belongsToProfile(item, profileId) {
  return normalizeProfileId(item?.profileId || "default") === normalizeProfileId(profileId);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function effectiveUserRole(user) {
  if (configuredAdminUsernames.has(normalizeUsername(user?.username))) return "admin";
  return user?.role === "admin" ? "admin" : "analyst";
}

function requireAdmin(user, response) {
  if (effectiveUserRole(user) === "admin") return true;
  send(response, 403, { error: "Administrator role required" });
  return false;
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function consumeAuthRateLimit(request, response, scope, subject, limit) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(request)}:${normalizeUsername(subject) || "anonymous"}`;

  for (const [bucketKey, bucket] of authRateBuckets) {
    if (bucket.resetAt <= now) authRateBuckets.delete(bucketKey);
  }

  const bucket = authRateBuckets.get(key) || { count: 0, resetAt: now + authRateWindowMs };
  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    response.setHeader("Retry-After", String(retryAfterSeconds));
    send(response, 429, { error: "Too many attempts. Try again later." });
    return false;
  }

  bucket.count += 1;
  authRateBuckets.set(key, bucket);
  return true;
}

function userIdFromUsername(username) {
  return `user-${createHash("sha256").update(normalizeUsername(username)).digest("hex").slice(0, 18)}`;
}

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: effectiveUserRole(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = Buffer.from(await scryptAsync(String(password), salt, 64)).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, storedHash = "") {
  const [scheme, salt, hash] = String(storedHash).split("$");

  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(await scryptAsync(String(password), salt, expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createAuthToken(user) {
  const expiresAt = Date.now() + authTokenTtlMs;
  const sessionVersion = Number(user.sessionVersion || 0);
  const payload = `${user.id}.${sessionVersion}.${expiresAt}`;
  const signature = createHmac("sha256", authSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthToken(token = "") {
  const parts = String(token).split(".");

  if (parts.length !== 4) {
    return null;
  }

  const [userId, sessionVersion, expiresAt, signature] = parts;
  const payload = `${userId}.${sessionVersion}.${expiresAt}`;
  const expected = createHmac("sha256", authSecret).update(payload).digest("base64url");

  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  if (Number(expiresAt) < Date.now()) {
    return null;
  }

  return { userId, sessionVersion: Number(sessionVersion) };
}

async function getAuthenticatedUser(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const verified = match ? verifyAuthToken(match[1]) : null;

  if (!verified?.userId) {
    return null;
  }

  const users = await readJson(usersFile);
  const user = users.find((item) => item.id === verified.userId) || null;
  if (!user || Number(user.sessionVersion || 0) !== verified.sessionVersion) return null;
  return user;
}

async function requireAuthenticatedUser(request, response) {
  const user = await getAuthenticatedUser(request);

  if (!user) {
    send(response, 401, { error: "Authentication required" });
    return null;
  }

  return user;
}

function canonicalAuditValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalAuditValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalAuditValue(value[key])])
    );
  }

  return value;
}

function auditSeal(eventHash, previousSeal = "") {
  return createHmac("sha256", authSecret)
    .update(`${previousSeal}:${eventHash}`)
    .digest("hex");
}

function verifyAuditChain(events = []) {
  let previousHash = "";
  let previousSeal = "";
  let sealed = 0;
  let legacy = 0;

  for (const event of [...events].reverse()) {
    const { eventHash, integritySeal, ...unsignedEvent } = event;
    const expectedHash = createHash("sha256")
      .update(JSON.stringify(canonicalAuditValue(unsignedEvent)))
      .digest("hex");
    if (event.previousHash !== previousHash || event.eventHash !== expectedHash) {
      return { valid: false, sealed, legacy, reason: "hash_chain_mismatch" };
    }
    if (integritySeal) {
      if (integritySeal !== auditSeal(eventHash, previousSeal)) {
        return { valid: false, sealed, legacy, reason: "integrity_seal_mismatch" };
      }
      sealed += 1;
      previousSeal = integritySeal;
    } else {
      legacy += 1;
    }
    previousHash = eventHash;
  }

  return { valid: true, sealed, legacy, reason: "" };
}

async function appendAuditEvent({ actor, action, entityType, entityId = "", before = null, after = null, reason = "", metadata = {} }) {
  return mutateStore(auditEventsFile, async (events) => {
    const previousHash = events[0]?.eventHash || "";
    const unsignedEvent = {
      id: makeId("audit"),
      actorId: actor?.id || "system",
      actorUsername: actor?.username || "system",
      action,
      entityType,
      entityId: String(entityId || ""),
      before,
      after,
      reason: String(reason || ""),
      metadata,
      previousHash,
      createdAt: new Date().toISOString(),
    };
    const eventHash = createHash("sha256")
      .update(JSON.stringify(canonicalAuditValue(unsignedEvent)))
      .digest("hex");
    const previousSeal = events[0]?.integritySeal || "";
    const event = { ...unsignedEvent, eventHash, integritySeal: auditSeal(eventHash, previousSeal) };
    return { items: [event, ...events], result: event };
  });
}

async function readEntityLabels() {
  const labels = await readJson(entityLabelsFile);
  return Array.isArray(labels) ? labels.filter((label) => !isDemoDataRecord(label)) : [];
}

async function writeEntityLabels(labels) {
  await writeJson(entityLabelsFile, labels.filter((label) => !isDemoDataRecord(label)));
}

function isDemoDataRecord(value) {
  if (!value || typeof value !== "object") return false;
  if (
    value.demo === true ||
    value.isDemo === true ||
    value.demoData === true ||
    value.testData === true ||
    value.synthetic === true
  ) return true;

  const explicitMode = String(value.dataMode || value.data_mode || "").trim().toLowerCase();
  if (["demo", "mock", "fixture", "synthetic", "sample", "test"].includes(explicitMode)) return true;

  const source = String(value.source || value.provider || "").trim().toLowerCase();
  return /^(?:demo|mock|fixture|synthetic|sample|test|entity-seed|seed-public-labels)(?::|$)/.test(source);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && quoted && nextChar === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

async function importEntityLabelsFromCsv(csvText) {
  return withStoreMutationLock(entityLabelsFile, async () => {
    const rows = String(csvText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const labels = await readEntityLabels();
    const now = new Date().toISOString();
    const existingKeys = new Set(
      labels.map((label) => `${String(label.address || "").toLowerCase()}:${label.networkKey || "UNKNOWN"}`)
    );
    const imported = [];
    let skipped = 0;

    for (const row of rows) {
    const [addressRaw, categoryRaw = "exchange", nameRaw = "Imported entity", networkRaw = "UNKNOWN", confidenceRaw = "80", sourceRaw = "csv-import", notesRaw = ""] = parseCsvLine(row);
    const address = String(addressRaw || "").trim();
    const networkKey = String(networkRaw || "UNKNOWN").trim() || "UNKNOWN";
    const key = `${address.toLowerCase()}:${networkKey}`;

    const candidate = {
      address,
      networkKey,
      category: normalizeEntityCategory(categoryRaw || "exchange"),
      name: String(nameRaw || categoryRaw || "Imported entity").trim() || "Imported entity",
      confidence: Math.min(100, Math.max(1, Number(confidenceRaw || 80))),
      source: String(sourceRaw || "csv-import").trim() || "csv-import",
      notes: String(notesRaw || "").trim(),
    };

    if (!address || /^address$/i.test(address) || existingKeys.has(key) || isDemoDataRecord(candidate)) {
      skipped += 1;
      continue;
    }

    existingKeys.add(key);
    imported.push({
      id: makeId("entity"),
      ...candidate,
      createdAt: now,
      updatedAt: now,
    });
    }

    if (imported.length) {
      await writeEntityLabels([...imported, ...labels]);
    }

    return { imported: imported.length, skipped, rowCount: rows.length, total: labels.length + imported.length };
  });
}

function decodeXmlText(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractXmlTexts(xml, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "gi");
  const values = [];
  let match;

  while ((match = regex.exec(xml))) {
    values.push(decodeXmlText(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "));
  }

  return values.filter(Boolean);
}

function extractXmlAttribute(tag = "", attributeName) {
  const escapedAttribute = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escapedAttribute}="([^"]*)"`, "i"));
  return match ? decodeXmlText(match[1]) : "";
}

function isOfacDigitalCurrencyFeature(typeText, values = []) {
  const text = [typeText, ...values].join(" ").toLowerCase();
  return /digital\s+currency|virtual\s+currency|cryptocurrency|crypto\s*currency|wallet\s+address/.test(text);
}

function inferOfacNetworkKey(typeText, address) {
  const text = String(typeText || "").toUpperCase();

  if (/TRON|TRX|TRC-?20/.test(text) || isTronAddress(address)) return "TRX";
  if (/BITCOIN|XBT|BTC/.test(text) || isBitcoinAddress(address)) return "BTC";
  if (/BINANCE|BSC|BNB|BEP-?20/.test(text)) return "BNB";
  if (/POLYGON|MATIC/.test(text)) return "POLYGON";
  if (/ARBITRUM/.test(text)) return "ARB";
  if (/AVALANCHE|AVAX/.test(text)) return "AVAX";
  if (/OPTIMISM/.test(text)) return "OP";
  if (/\bBASE\b/.test(text)) return "BASE";
  if (/ETHEREUM|ETHER|\bETH\b|ERC-?20/.test(text) || isEvmAddress(address)) return "ETH";
  if (/LITECOIN|\bLTC\b/.test(text)) return "LTC";
  if (/DASH/.test(text)) return "DASH";
  if (/ZCASH|\bZEC\b/.test(text)) return "ZEC";
  if (/MONERO|\bXMR\b/.test(text)) return "XMR";
  if (/RIPPLE|\bXRP\b/.test(text)) return "XRP";
  if (/BITCOIN\s+CASH|\bBCH\b/.test(text)) return "BCH";

  return "UNKNOWN";
}

function extractOfacDigitalCurrencyAddresses(typeText, values = []) {
  const candidates = values.join(" ");
  const matches = [];
  const seen = new Set();
  const patterns = [
    /0x[a-fA-F0-9]{40}/g,
    /\bT[A-Za-z0-9]{25,40}\b/g,
    /\b(?:bc1[a-zA-HJ-NP-Z0-9]{20,90}|[13][a-zA-HJ-NP-Z0-9]{25,90})\b/gi,
    /\b(?:ltc1[0-9a-z]{25,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,40})\b/g,
    /\bX[1-9A-HJ-NP-Za-km-z]{30,40}\b/g,
    /\bt[13][A-Za-z0-9]{25,40}\b/g,
    /\b[48][0-9AB][1-9A-HJ-NP-Za-km-z]{90,110}\b/g,
    /\br[1-9A-HJ-NP-Za-km-z]{25,40}\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of candidates.matchAll(pattern)) {
      const address = match[0].replace(/[.,;:)\]}]+$/, "");
      const key = address.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        matches.push({
          address,
          networkKey: inferOfacNetworkKey(typeText, address),
        });
      }
    }
  }

  return matches;
}

function parseOfacEntityLabels(xmlText, sourceFile, now) {
  const entityRegex = /<entity\b([^>]*)>([\s\S]*?)<\/entity>/gi;
  const featureRegex = /<feature\b([^>]*)>([\s\S]*?)<\/feature>/gi;
  const labels = [];
  let entityMatch;

  while ((entityMatch = entityRegex.exec(xmlText))) {
    const entityId = extractXmlAttribute(entityMatch[1], "id");
    const entityXml = entityMatch[2];
    const primaryName =
      extractXmlTexts(entityXml, "formattedFullName")[0] ||
      extractXmlTexts(entityXml, "formattedLastName")[0] ||
      `OFAC entity ${entityId || "unknown"}`;
    const sanctionsLists = extractXmlTexts(entityXml, "sanctionsList");
    const sanctionsPrograms = extractXmlTexts(entityXml, "sanctionsProgram");
    let featureMatch;

    while ((featureMatch = featureRegex.exec(entityXml))) {
      const featureXml = featureMatch[2];
      const typeText = extractXmlTexts(featureXml, "type")[0] || "";
      const values = extractXmlTexts(featureXml, "value");

      if (!isOfacDigitalCurrencyFeature(typeText, values)) {
        continue;
      }

      for (const item of extractOfacDigitalCurrencyAddresses(typeText, values)) {
        labels.push({
          id: makeId("ofac"),
          address: item.address,
          networkKey: item.networkKey,
          category: "sanctions",
          name: `OFAC ${sanctionsLists[0] || "Sanctions List"}: ${primaryName}`,
          confidence: 100,
          source: `ofac-sls:${sourceFile}`,
          notes: [
            entityId ? `OFAC entity id ${entityId}` : "",
            sanctionsPrograms.length ? `Programs: ${sanctionsPrograms.join(", ")}` : "",
            typeText ? `Feature: ${typeText}` : "",
          ].filter(Boolean).join("; "),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  return labels;
}

async function fetchOfacSlsFile(filename) {
  if (!/^[a-z0-9_.-]+$/i.test(filename)) {
    throw new Error(`Unsafe OFAC SLS filename: ${filename}`);
  }

  const url = `${ofacSlsBaseUrl}/api/download/${encodeURIComponent(filename)}`;
  const response = await withProviderTelemetry("OFAC SLS API", `download ${filename}`, () => fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,*/*",
    },
  }));

  if (!response.ok) {
    throw new Error(`OFAC SLS ${filename} failed with HTTP ${response.status}`);
  }

  const text = await response.text();

  if (!/<entities\b|<sdnList\b|<sanctions/i.test(text)) {
    throw new Error(`OFAC SLS ${filename} did not return XML sanctions data`);
  }

  return text;
}

async function importOfacEntityLabels(options = {}) {
  return withStoreMutationLock(entityLabelsFile, async () => {
    const files = (Array.isArray(options.files) && options.files.length ? options.files : ofacSlsFiles)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
    const labels = await readEntityLabels();
    const now = new Date().toISOString();
    const existingKeys = new Set(
      labels.map((label) => `${String(label.address || "").toLowerCase()}:${label.networkKey || "UNKNOWN"}`)
    );
    const imported = [];
    const fileResults = [];
    let parsed = 0;
    let skipped = 0;

    for (const file of files) {
    const xmlText = await fetchOfacSlsFile(file);
    const parsedLabels = parseOfacEntityLabels(xmlText, file, now);
    parsed += parsedLabels.length;
    let fileImported = 0;
    let fileSkipped = 0;

    for (const label of parsedLabels) {
      const key = `${label.address.toLowerCase()}:${label.networkKey || "UNKNOWN"}`;

      if (!label.address || existingKeys.has(key)) {
        skipped += 1;
        fileSkipped += 1;
        continue;
      }

      existingKeys.add(key);
      imported.push(label);
      fileImported += 1;
    }

    fileResults.push({
      file,
      parsed: parsedLabels.length,
      imported: fileImported,
      skipped: fileSkipped,
    });
    }

    if (imported.length) {
      await writeEntityLabels([...imported, ...labels]);
    }

    return {
      imported: imported.length,
      skipped,
      parsed,
      total: labels.length + imported.length,
      files: fileResults,
      source: ofacSlsBaseUrl,
    };
  });
}

async function readBody(request) {
  const chunks = [];
  let receivedBytes = 0;

  for await (const chunk of request) {
    receivedBytes += chunk.length;

    if (receivedBytes > requestBodyLimitBytes) {
      const error = new Error(`Request body exceeds ${requestBodyLimitBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("Invalid JSON request body");
    error.statusCode = 400;
    throw error;
  }
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Content-Type": "application/json",
  };

  if (response.corsOrigin) {
    headers["Access-Control-Allow-Origin"] = response.corsOrigin;
    headers.Vary = "Origin";
  }

  response.writeHead(status, headers);
  response.end(body);
}

function requestCorsOrigin(request) {
  const origin = String(request.headers.origin || "").trim();
  return origin && corsAllowedOrigins.has(origin) ? origin : "";
}

function isConfigured(value) {
  return Boolean(String(value || "").trim());
}

async function recordProviderCall({ provider, operation, ok, status = null, durationMs, message = "" }) {
  if (!usePostgres) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO provider_call_events (provider, operation, ok, status, duration_ms, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [provider, operation, ok, status, Math.round(durationMs), String(message || "").slice(0, 500)]
    );
  } catch {
    // Telemetry should never break product flows.
  }
}

async function withProviderTelemetry(provider, operation, task) {
  const startedAt = Date.now();

  try {
    const result = await task();
    const status = Number(result?.status);
    await recordProviderCall({
      provider,
      operation,
      ok: !Number.isFinite(status) || (status >= 200 && status < 400),
      status: Number.isFinite(status) ? status : null,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await recordProviderCall({
      provider,
      operation,
      ok: false,
      durationMs: Date.now() - startedAt,
      message: error.message,
    });
    throw error;
  }
}

async function providerHealthSummary() {
  if (!usePostgres) {
    return {};
  }

  try {
    const result = await pool.query(`
      SELECT provider,
             COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE ok)::int AS ok_calls,
             ROUND(AVG(duration_ms))::int AS avg_duration_ms,
             MAX(created_at) AS last_seen_at,
             (ARRAY_AGG(message ORDER BY created_at DESC) FILTER (WHERE NOT ok AND message <> ''))[1] AS last_error
      FROM provider_call_events
      WHERE created_at > now() - interval '24 hours'
      GROUP BY provider
    `);

    return Object.fromEntries(result.rows.map((row) => [
      row.provider,
      {
        calls: row.calls,
        okCalls: row.ok_calls,
        errorCalls: row.calls - row.ok_calls,
        successRate: row.calls ? Number((row.ok_calls / row.calls).toFixed(3)) : null,
        avgDurationMs: row.avg_duration_ms,
        lastSeenAt: row.last_seen_at,
        lastError: row.last_error || "",
      },
    ]));
  } catch {
    return {};
  }
}

async function providerCapabilities() {
  const blockscoutNetworks = evmNetworks
    .filter((network) => blockscoutBaseUrl(network.key))
    .map((network) => network.key);
  const alchemyNetworks = evmNetworks
    .filter((network) => alchemyEndpoint(network.key))
    .map((network) => network.key);
  const health = await providerHealthSummary();

  return {
    generatedAt: new Date().toISOString(),
    dataPolicy: {
      demoDataEnabled: false,
      allowedModes: ["live", "cached", "imported", "analyst"],
      message: "Demo, mock, fixture, sample, test and synthetic records are disabled at the backend boundary.",
    },
    health,
    tasks: {
      evmLiveSnapshot: {
        providers: [
          {
            name: "Public EVM JSON-RPC (no API key)",
            configured: true,
            uses: ["eth_getBalance", "eth_getTransactionCount", "eth_blockNumber"],
            networks: Object.keys(publicRpcEndpoints),
          },
        ],
      },
      evmTransactions: {
        providers: [
          {
            name: "Etherscan API v2",
            configured: isConfigured(providerCredential("ETHERSCAN_API_KEY")),
            uses: ["account.txlist", "account.tokentx", "chainid"],
            networks: evmNetworks.map((network) => network.key),
          },
          {
            name: "Alchemy Transfers API",
            configured: isConfigured(providerCredential("ALCHEMY_API_KEY")),
            uses: ["alchemy_getAssetTransfers external/internal/erc20"],
            networks: alchemyNetworks,
          },
          {
            name: "Blockscout API",
            configured: blockscoutNetworks.length > 0,
            uses: ["account.txlist", "account.tokentx"],
            networks: blockscoutNetworks,
          },
          {
            name: "Routescan API",
            configured: true,
            uses: ["Etherscan-compatible account.txlist"],
            networks: evmNetworks.map((network) => network.key),
          },
          {
            name: transactionCacheProviderName,
            configured: true,
            uses: [transactionCacheDescription],
            networks: ["EVM", "TRX"],
          },
        ],
      },
      evmTokenBalances: {
        providers: [
          {
            name: "Alchemy Token API",
            configured: isConfigured(providerCredential("ALCHEMY_API_KEY")),
            uses: ["alchemy_getTokenBalances", "alchemy_getTokenMetadata"],
            networks: alchemyNetworks,
          },
        ],
      },
      evmNftExposure: {
        providers: [
          {
            name: "Alchemy NFT API",
            configured: isConfigured(providerCredential("ALCHEMY_API_KEY")),
            uses: ["getNFTsForOwner"],
            networks: alchemyNetworks,
          },
        ],
      },
      tronTransactions: {
        providers: [
          {
            name: "TRON public API",
            configured: true,
            keyConfigured: isConfigured(providerCredential("VITE_TRONGRID_API_KEY", "TRONGRID_API_KEY")),
            uses: ["/wallet/getaccount", "/v1/accounts/{address}/transactions", "/v1/accounts/{address}/transactions/trc20"],
            networks: ["TRX"],
          },
          {
            name: transactionCacheProviderName,
            configured: true,
            uses: [transactionCacheDescription],
            networks: ["TRX"],
          },
        ],
      },
      bitcoinTransactions: {
        providers: [
          {
            name: "Mempool.space API",
            configured: true,
            uses: ["/address/{address}", "/address/{address}/txs/chain", "/blocks/tip/height"],
            networks: ["BTC"],
          },
          {
            name: "Blockstream Esplora API",
            configured: true,
            uses: ["/address/{address}", "/address/{address}/txs/chain", "/blocks/tip/height"],
            networks: ["BTC"],
          },
          {
            name: "Blockchain.com API",
            configured: true,
            uses: ["/rawaddr/{address}", "/q/getblockcount"],
            networks: ["BTC"],
          },
          {
            name: transactionCacheProviderName,
            configured: true,
            uses: [transactionCacheDescription],
            networks: ["BTC"],
          },
        ],
      },
      attribution: {
        providers: [
          {
            name: "Blockscout public address tags",
            configured: Boolean(blockscoutBaseUrl("ETH")),
            uses: ["/api/v2/addresses/{address}"],
            networks: ["ETH"],
          },
          {
            name: "TRONSCAN public account labels",
            configured: isConfigured(providerCredential("TRONSCAN_API_KEY")),
            uses: ["/api/accountv2 publicTag/addressTag/blueTag"],
            networks: ["TRX"],
          },
          {
            name: "Arkham Intel API",
            configured: isConfigured(providerCredential("ARKHAM_API_KEY")),
            uses: ["/intelligence/address_enriched/{address}/all"],
            networks: ["EVM", "TRX", "BTC", "cross-chain where Arkham has coverage"],
          },
          {
            name: "Local entity labels",
            configured: true,
            uses: ["manual labels", "CSV imports", "OFAC SLS imports"],
            networks: ["ALL"],
          },
          {
            name: "OFAC Sanctions List Service",
            configured: true,
            uses: ["/api/download/SDN_ENHANCED.XML", "/api/download/CONS_ENHANCED.XML"],
            networks: ["BTC", "ETH", "TRX", "EVM aliases", "other digital currency addresses"],
          },
        ],
      },
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scheduleEtherscanRequest(task) {
  const run = etherscanQueue.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - lastEtherscanRequestAt;

    if (elapsed < etherscanRequestDelayMs) {
      await sleep(etherscanRequestDelayMs - elapsed);
    }

    lastEtherscanRequestAt = Date.now();
    return task();
  });

  etherscanQueue = run.catch(() => undefined);
  return run;
}

function scheduleRoutescanRequest(task) {
  const run = routescanQueue.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - lastRoutescanRequestAt;

    if (elapsed < routescanRequestDelayMs) {
      await sleep(routescanRequestDelayMs - elapsed);
    }

    lastRoutescanRequestAt = Date.now();
    return task();
  });

  routescanQueue = run.catch(() => undefined);
  return run;
}

function isEtherscanRateLimit(message = "") {
  return /rate limit|max calls per sec|too many requests/i.test(message);
}

function isEtherscanUnsupportedChain(message = "") {
  return /free api access is not supported for this chain|upgrade your api plan/i.test(message);
}

function profileIdFromUrl(url) {
  const prefix = "/api/wallets/";

  if (!url.pathname.startsWith(prefix)) {
    return "";
  }

  return decodeURIComponent(url.pathname.slice(prefix.length));
}

function idFromUrl(url, prefix) {
  if (!url.pathname.startsWith(prefix)) {
    return "";
  }

  return decodeURIComponent(url.pathname.slice(prefix.length));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(12).toString("hex")}`;
}

function hexToBigInt(value) {
  if (!value || value === "0x") {
    return 0n;
  }

  return BigInt(value);
}

function formatNativeBalance(hexBalance) {
  const wei = hexToBigInt(hexBalance);
  const integer = wei / 10n ** 18n;
  const fraction = wei % 10n ** 18n;
  return `${integer}.${fraction.toString().padStart(18, "0").slice(0, 4)}`;
}

function formatTrx(sun = 0) {
  return (Number(sun || 0) / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  });
}

function nativeDecimalsForNetwork(networkKey) {
  if (networkKey === "TRX") {
    return 6;
  }

  if (networkKey === "BTC") {
    return 8;
  }

  return 18;
}

function formatBtc(sats = 0) {
  return formatDecimalUnits(String(sats || 0), 8);
}

function isBitcoinAddress(address) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/i.test(address || "");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest();
}

function base58Encode(buffer) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${buffer.toString("hex") || "0"}`);
  let output = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    output = alphabet[remainder] + output;
    value /= 58n;
  }

  for (const byte of buffer) {
    if (byte !== 0) {
      break;
    }
    output = alphabet[0] + output;
  }

  return output || alphabet[0];
}

function tronAddressFromHex(value) {
  if (!/^41[a-fA-F0-9]{40}$/.test(value || "")) {
    return value || "";
  }

  const payload = Buffer.from(value, "hex");
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function decodeTronAssetName(assetName) {
  const text = String(assetName || "");
  if (!text) return "";
  if (/^\d+$/.test(text)) return `Token ${text}`;
  if (/^[a-fA-F0-9]+$/.test(text) && text.length % 2 === 0) {
    try {
      const decoded = Buffer.from(text, "hex").toString("utf8").replace(/\0/g, "").trim();
      return decoded || text;
    } catch {
      return text;
    }
  }
  return text;
}

async function publicRpc(endpoint, method, params = []) {
  const response = await withProviderTelemetry("Public EVM JSON-RPC", method, () => fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  }));

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.error) {
    throw new Error(payload.error.message || "JSON-RPC error");
  }

  return payload.result;
}

async function tronPost(path, body) {
  const cacheKey = `POST:${path}:${JSON.stringify(body || {})}`;
  const cached = cachedTronPayload(cacheKey);

  if (cached) {
    return cached;
  }

  const response = await fetchTronWithRetry({ method: "POST", path, body });

  if (!response.ok) {
    const stale = cachedTronPayload(cacheKey, true);

    if (stale) {
      return stale;
    }

    if (response.status === 429) {
      throw new Error("Публичный TRON API временно ограничил запросы (HTTP 429). Автоматические повторы выполнены; подождите 1–2 минуты и повторите проверку.");
    }

    throw new Error(`Публичный TRON API: HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.Error) {
    throw new Error(payload.Error);
  }

  saveTronPayload(cacheKey, payload);
  return payload;
}

async function tronGet(path) {
  const cacheKey = `GET:${path}`;
  const cached = cachedTronPayload(cacheKey);

  if (cached) {
    return cached;
  }

  const response = await fetchTronWithRetry({ method: "GET", path });

  if (!response.ok) {
    const stale = cachedTronPayload(cacheKey, true);

    if (stale) {
      return stale;
    }

    if (response.status === 429) {
      throw new Error("Публичный TRON API временно ограничил запросы (HTTP 429). Автоматические повторы выполнены; подождите 1–2 минуты и повторите проверку.");
    }

    throw new Error(`Публичный TRON API: HTTP ${response.status}`);
  }

  const payload = await response.json();
  saveTronPayload(cacheKey, payload);
  return payload;
}

async function arkhamGet(path) {
  const apiKey = providerCredential("ARKHAM_API_KEY");

  if (!apiKey) {
    return {
      providerRequired: true,
      provider: "Arkham Intel API",
      message: "ARKHAM_API_KEY is required for Arkham intelligence enrichment.",
    };
  }

  const response = await withProviderTelemetry("Arkham Intel API", `GET ${path.split("?")[0]}`, () => fetch(`${serviceProtocol}://${arkhamHost}${path}`, {
    headers: {
      "API-Key": apiKey,
    },
  }));

  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload.message || payload.error || payload.raw || `Arkham HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickEntityName(entity) {
  if (!entity) {
    return "";
  }

  if (typeof entity === "string") {
    return entity;
  }

  return entity.name || entity.label || entity.id || entity.entity || "";
}

function normalizeArkhamIntelligence(address, payload) {
  const objectValues = payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.values(payload).filter((item) => item && typeof item === "object")
    : [];
  const records = Array.isArray(payload)
    ? payload
    : toArray(payload.items).length
      ? payload.items
      : toArray(payload.addresses).length
        ? payload.addresses
        : toArray(payload.results).length
          ? payload.results
          : objectValues.some((item) => item.address || item.chain || item.arkhamEntity || item.arkhamLabel)
            ? objectValues
            : [payload].filter((item) => item && Object.keys(item).length);

  const labels = [];
  const entities = [];
  const tags = [];
  const chains = new Set();

  for (const record of records) {
    for (const value of [record.chain, record.chainId, record.network].filter(Boolean)) {
      chains.add(String(value));
    }

    const entity =
      record.arkhamEntity ||
      record.entity ||
      record.owner ||
      record.service ||
      record.depositExchange ||
      record.deposit_exchange;
    const entityName = pickEntityName(entity);

    if (entityName) {
      entities.push({
        id: typeof entity === "object" ? entity.id || entity.entity || entityName : entityName,
        name: entityName,
        type: typeof entity === "object" ? entity.type || entity.entityType || record.entityType || "" : record.entityType || "",
      });
    }

    for (const label of [
      record.label,
      record.name,
      record.arkhamLabel,
      ...toArray(record.labels),
      ...toArray(record.addressLabels),
    ].filter(Boolean)) {
      labels.push(typeof label === "string" ? { name: label } : {
        name: label.name || label.label || label.id || "Arkham label",
        type: label.type || label.category || "",
        confidence: label.confidence || record.confidence || null,
      });
    }

    for (const tag of [...toArray(record.tags), ...toArray(record.addressTags), ...toArray(record.populatedTags)].filter(Boolean)) {
      tags.push(typeof tag === "string" ? { name: tag } : {
        name: tag.name || tag.label || tag.id || "Arkham tag",
        type: tag.type || tag.category || "",
      });
    }
  }

  const uniqueByName = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.name || item.id || ""}:${item.type || ""}`.toLowerCase();
      if (!key.trim() || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  };

  return {
    address,
    provider: "Arkham Intel API",
    providerRequired: false,
    chains: [...chains],
    entities: uniqueByName(entities).slice(0, 12),
    labels: uniqueByName(labels).slice(0, 20),
    tags: uniqueByName(tags).slice(0, 20),
    raw: payload,
    checkedAt: new Date().toISOString(),
  };
}

async function getArkhamAddressIntelligence(address) {
  const payload = await arkhamGet(`/intelligence/address_enriched/${encodeURIComponent(address)}/all`);

  if (payload.providerRequired) {
    return payload;
  }

  return normalizeArkhamIntelligence(address, payload);
}

function scheduleTronRequest(task) {
  const run = tronRequestQueue.catch(() => undefined).then(async () => {
    const hasApiKey = Boolean(providerCredential("VITE_TRONGRID_API_KEY", "TRONGRID_API_KEY"));
    const interval = hasApiKey ? 0 : tronPublicRequestIntervalMs;
    const elapsed = Date.now() - lastTronRequestAt;

    if (elapsed < interval) {
      await sleep(interval - elapsed);
    }

    lastTronRequestAt = Date.now();
    return task();
  });

  tronRequestQueue = run.catch(() => undefined);
  return run;
}

function tronRetryDelay(response, attempt) {
  const retryAfter = String(response?.headers?.get?.("retry-after") || "").trim();

  if (/^\d+$/.test(retryAfter)) {
    return Math.min(30_000, Math.max(1_000, Number(retryAfter) * 1000));
  }

  const retryAt = Date.parse(retryAfter);

  if (Number.isFinite(retryAt)) {
    return Math.min(30_000, Math.max(1_000, retryAt - Date.now()));
  }

  return Math.min(15_000, tronPublicRetryBaseMs * (2 ** attempt));
}

function cachedTronPayload(cacheKey, allowStale = false) {
  const cached = tronResponseCache.get(cacheKey);

  if (!cached || (!allowStale && Date.now() - cached.savedAt > tronPublicCacheTtlMs)) {
    return null;
  }

  return cached.payload;
}

function saveTronPayload(cacheKey, payload) {
  tronResponseCache.set(cacheKey, { payload, savedAt: Date.now() });

  if (tronResponseCache.size > 600) {
    const oldestKey = tronResponseCache.keys().next().value;
    tronResponseCache.delete(oldestKey);
  }
}

async function fetchTronWithRetry({ method, path, body = null }) {
  const apiKey = providerCredential("VITE_TRONGRID_API_KEY", "TRONGRID_API_KEY");
  let response = null;

  for (let attempt = 0; attempt <= tronPublicMaxRetries; attempt += 1) {
    response = await scheduleTronRequest(() => withProviderTelemetry(
      "TRON public API",
      `${method} ${path.split("?")[0]}${attempt ? ` retry ${attempt}` : ""}`,
      () => fetch(`${serviceProtocol}://${trongridHost}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(apiKey ? { "TRON-PRO-API-KEY": apiKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ));

    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt >= tronPublicMaxRetries) {
      return response;
    }

    await sleep(tronRetryDelay(response, attempt));
  }

  return response;
}

function arkhamEntityCategory(entity) {
  const text = `${entity?.type || ""} ${entity?.name || ""}`.toLowerCase();
  if (/(mixer|tornado|privacy|coinjoin|launder)/.test(text)) return "mixer";
  if (/(exchange|cex|dex|binance|coinbase|kraken|okx|bybit)/.test(text)) return "exchange";
  if (/(bridge|cross-chain|cross chain)/.test(text)) return "bridge";
  if (/(scam|phish|exploit|hack|ransom|sanction|drainer)/.test(text)) return "scam";
  return "service";
}

function pickArkhamEntityLabel(intelligence) {
  const entity = intelligence?.entities?.find((item) => item?.name) || null;

  if (!entity) {
    return null;
  }

  const rawConfidence = Number(entity.confidence || 0);
  const confidence = rawConfidence > 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;

  return {
    category: arkhamEntityCategory(entity),
    confidence: Math.min(100, Math.max(1, confidence ? Math.round(confidence) : 92)),
    name: String(entity.name || "Known entity").trim(),
    type: String(entity.type || "").trim(),
  };
}

async function saveArkhamEntityLabelForAddress({ address, networkKey = "ALL", source = "arkham-chain-scan" }) {
  const cleanAddress = String(address || "").trim();

  if (!cleanAddress) {
    return null;
  }

  const intelligence = await withApiResponseCache({
    cacheKey: `arkham:${normalizeCacheAddress(cleanAddress)}`,
    ttlMs: arkhamCacheTtlMs,
    load: () => getArkhamAddressIntelligence(cleanAddress),
  });
  const entity = pickArkhamEntityLabel(intelligence);

  if (!entity) {
    return null;
  }

  const labels = await readEntityLabels();
  const normalizedAddress = cleanAddress.toLowerCase();
  const labelNetworkKey = String(networkKey || "ALL").trim() || "ALL";
  const existing = labels.find((label) => {
    const sameAddress = String(label.address || "").toLowerCase() === normalizedAddress;
    const existingNetwork = String(label.networkKey || "UNKNOWN");
    return sameAddress && (
      existingNetwork === labelNetworkKey ||
      existingNetwork === "ALL" ||
      existingNetwork === "UNKNOWN" ||
      labelNetworkKey === "ALL"
    );
  });

  if (existing) {
    return {
      label: existing,
      status: "existing",
      intelligence,
    };
  }

  const now = new Date().toISOString();
  const label = {
    id: makeId("entity"),
    address: cleanAddress,
    networkKey: labelNetworkKey,
    category: entity.category,
    name: entity.name,
    confidence: entity.confidence,
    source,
    notes: entity.type ? `Arkham chain scan entity type: ${entity.type}` : "Arkham chain scan entity",
    createdAt: now,
    updatedAt: now,
  };

  await writeEntityLabels([label, ...labels]);

  return {
    label,
    status: "saved",
    intelligence,
  };
}

function pickArkhamNametag(intelligence) {
  const entity = intelligence?.entities?.[0]?.name || "";
  const label = intelligence?.labels?.[0]?.name || "";
  const tag = intelligence?.tags?.[0]?.name || "";

  return entity || label || tag || "";
}

async function getArkhamNodeNametag(address) {
  const cacheKey = String(address || "").toLowerCase();

  if (!cacheKey) {
    return null;
  }

  if (arkhamNodeCache.has(cacheKey)) {
    return arkhamNodeCache.get(cacheKey);
  }

  try {
    const intelligence = await getArkhamAddressIntelligence(address);

    if (intelligence.providerRequired) {
      arkhamNodeCache.set(cacheKey, null);
      return null;
    }

    const nametag = pickArkhamNametag(intelligence);
    const value = nametag
      ? {
          nametag,
          entities: intelligence.entities || [],
          labels: intelligence.labels || [],
          tags: intelligence.tags || [],
          provider: "Arkham Intel API",
        }
      : null;

    arkhamNodeCache.set(cacheKey, value);
    return value;
  } catch {
    arkhamNodeCache.set(cacheKey, null);
    return null;
  }
}

function resolveEvmNetwork(rule) {
  const networkName = rule.networkName || "Ethereum";
  return (
    evmNetworks.find((network) => network.name === networkName || network.key === rule.networkKey) ||
    evmNetworks[0]
  );
}

async function getEvmSnapshot(rule) {
  const network = resolveEvmNetwork(rule);
  const endpoint = publicRpcEndpoints[network.key];

  if (!endpoint) {
    throw new Error(`Бесплатный публичный RPC пока не настроен для ${network.name}`);
  }

  const [balanceHex, txCountHex, blockHex] = await Promise.all([
    publicRpc(endpoint, "eth_getBalance", [rule.address, "latest"]),
    publicRpc(endpoint, "eth_getTransactionCount", [rule.address, "latest"]),
    publicRpc(endpoint, "eth_blockNumber"),
  ]);

  return {
    address: rule.address,
    networkKey: network.key,
    networkName: network.name,
    symbol: network.symbol,
    balance: formatNativeBalance(balanceHex),
    balanceRaw: balanceHex,
    txCount: Number(hexToBigInt(txCountHex)),
    blockNumber: Number(hexToBigInt(blockHex)),
    checkedAt: new Date().toISOString(),
  };
}

async function getEvmLiveProfile(address) {
  const publicNetworks = evmNetworks.filter((network) => publicRpcEndpoints[network.key]);
  const snapshots = await Promise.allSettled(
    publicNetworks.map((network) =>
      getEvmSnapshot({
        address,
        networkKey: network.key,
        networkName: network.name,
      })
    )
  );
  const candidates = snapshots
    .filter((snapshot) => snapshot.status === "fulfilled")
    .map((snapshot) => snapshot.value)
    .sort((a, b) => {
      if (a.txCount !== b.txCount) {
        return b.txCount - a.txCount;
      }

      const aBalance = hexToBigInt(a.balanceRaw);
      const bBalance = hexToBigInt(b.balanceRaw);

      if (aBalance > bBalance) return -1;
      if (aBalance < bBalance) return 1;
      return a.networkName.localeCompare(b.networkName);
    });

  if (!candidates.length) {
    const firstError = snapshots.find((snapshot) => snapshot.status === "rejected")?.reason;
    throw new Error(firstError?.message || "Бесплатные публичные EVM RPC недоступны");
  }

  return {
    selected: {
      ...candidates[0],
      source: "Public EVM JSON-RPC (без API-ключа)",
    },
    candidates: candidates.map((candidate) => ({
      ...candidate,
      source: "Public EVM JSON-RPC (без API-ключа)",
    })),
  };
}

async function getTronSnapshot(rule) {
  const [account, transactions, block] = await Promise.all([
    tronPost("/wallet/getaccount", { address: rule.address, visible: true }),
    tronGet(`/v1/accounts/${encodeURIComponent(rule.address)}/transactions?limit=1&only_confirmed=true&order_by=block_timestamp,desc`),
    tronPost("/wallet/getnowblock", {}),
  ]);

  const latestTransaction = transactions.data?.[0] || null;

  return {
    address: rule.address,
    networkKey: "TRX",
    networkName: "TRON",
    symbol: "TRX",
    balance: formatTrx(account.balance),
    balanceRaw: String(account.balance || 0),
    txCount: transactions.meta?.total ?? transactions.data?.length ?? 0,
    latestTxId: latestTransaction?.txID || "",
    accountCreatedAt: account.create_time ? new Date(Number(account.create_time)).toISOString() : null,
    latestActivityAt: latestTransaction?.block_timestamp ? new Date(Number(latestTransaction.block_timestamp)).toISOString() : null,
    blockNumber: block.block_header?.raw_data?.number ?? null,
    checkedAt: new Date().toISOString(),
  };
}

async function getTronLiveProfile(address) {
  const selected = {
    ...(await getTronSnapshot({ address, networkName: "TRON" })),
    source: credentialedProvidersEnabled ? "TRON Developer / TronGrid API" : "TRON public API (без API-ключа)",
  };

  return {
    selected,
    candidates: [selected],
  };
}

async function bitcoinJson(provider, baseUrl, path) {
  const response = await withProviderTelemetry(provider, path, () => fetch(`${baseUrl}${path}`));

  if (!response.ok) {
    throw new Error(`${provider} HTTP ${response.status}`);
  }

  return response.json();
}

async function bitcoinText(provider, baseUrl, path) {
  const response = await withProviderTelemetry(provider, path, () => fetch(`${baseUrl}${path}`));

  if (!response.ok) {
    throw new Error(`${provider} HTTP ${response.status}`);
  }

  return response.text();
}

function bitcoinStatsBalanceSats(stats = {}) {
  const chain = stats.chain_stats || {};
  const mempool = stats.mempool_stats || {};
  return Number(chain.funded_txo_sum || 0) - Number(chain.spent_txo_sum || 0) + Number(mempool.funded_txo_sum || 0) - Number(mempool.spent_txo_sum || 0);
}

function normalizeBitcoinSnapshot({ address, stats, blockHeight, provider }) {
  const chain = stats.chain_stats || {};
  const mempool = stats.mempool_stats || {};
  const txCount = Number(chain.tx_count || 0) + Number(mempool.tx_count || 0);
  const balanceSats = bitcoinStatsBalanceSats(stats);

  return {
    address,
    networkKey: "BTC",
    networkName: "Bitcoin",
    symbol: "BTC",
    balance: formatBtc(balanceSats),
    balanceRaw: String(balanceSats),
    txCount,
    blockNumber: Number(blockHeight || 0) || null,
    checkedAt: new Date().toISOString(),
    source: provider,
  };
}

async function getEsploraBitcoinSnapshot({ address, baseUrl, provider }) {
  const [stats, blockHeight] = await Promise.all([
    bitcoinJson(provider, baseUrl, `/address/${encodeURIComponent(address)}`),
    bitcoinText(provider, baseUrl, "/blocks/tip/height"),
  ]);

  return normalizeBitcoinSnapshot({ address, stats, blockHeight, provider });
}

async function getBlockchainBitcoinSnapshot(address) {
  const [rawAddress, blockHeight] = await Promise.all([
    bitcoinJson("Blockchain.com API", blockchainApiBase, `/rawaddr/${encodeURIComponent(address)}?limit=1`),
    bitcoinText("Blockchain.com API", blockchainApiBase, "/q/getblockcount"),
  ]);

  return {
    address,
    networkKey: "BTC",
    networkName: "Bitcoin",
    symbol: "BTC",
    balance: formatBtc(rawAddress.final_balance || 0),
    balanceRaw: String(rawAddress.final_balance || 0),
    txCount: Number(rawAddress.n_tx || 0),
    latestTxId: rawAddress.txs?.[0]?.hash || "",
    blockNumber: Number(blockHeight || 0) || null,
    checkedAt: new Date().toISOString(),
    source: "Blockchain.com API",
  };
}

async function getBitcoinLiveProfile(address) {
  const snapshots = await Promise.allSettled([
    getEsploraBitcoinSnapshot({ address, baseUrl: mempoolApiBase, provider: "Mempool.space API" }),
    getEsploraBitcoinSnapshot({ address, baseUrl: blockstreamApiBase, provider: "Blockstream Esplora API" }),
    getBlockchainBitcoinSnapshot(address),
  ]);
  const candidates = snapshots
    .filter((snapshot) => snapshot.status === "fulfilled")
    .map((snapshot) => snapshot.value)
    .sort((a, b) => {
      if (a.txCount !== b.txCount) {
        return b.txCount - a.txCount;
      }

      return Number(b.balanceRaw || 0) - Number(a.balanceRaw || 0);
    });

  if (!candidates.length) {
    const firstError = snapshots.find((snapshot) => snapshot.status === "rejected")?.reason;
    throw new Error(firstError?.message || "Bitcoin API request failed");
  }

  return {
    selected: candidates[0],
    candidates,
  };
}

async function getRuleSnapshot(rule) {
  if (/^T[A-Za-z0-9]{25,40}$/.test(rule.address) || rule.networkName === "TRON") {
    return getTronSnapshot(rule);
  }

  if (isBitcoinAddress(rule.address) || rule.networkName === "Bitcoin" || rule.networkKey === "BTC") {
    return (await getBitcoinLiveProfile(rule.address)).selected;
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(rule.address)) {
    return getEvmSnapshot(rule);
  }

  throw new Error("Polling supports EVM, TRON and Bitcoin addresses in this MVP");
}

async function getRuleSnapshots(rule) {
  if (/^0x[a-fA-F0-9]{40}$/.test(rule.address)) {
    const result = await getEvmLiveProfile(rule.address);
    const enriched = await Promise.allSettled(
      result.candidates.map(async (snapshot) => {
        const transactions = await getTransactionsWithCache({
          address: rule.address,
          networkKey: snapshot.networkKey,
          page: 1,
          limit: 1,
        });
        const latest = transactions.items?.[0] || null;

        return {
          ...snapshot,
          scope: "EVM",
          ...latestTxDetails(latest, rule.address),
          latestProvider: transactions.provider || latest?.provider || "",
        };
      })
    );

    return enriched.map((item, index) =>
      item.status === "fulfilled"
        ? item.value
        : {
            ...result.candidates[index],
            scope: "EVM",
            latestTxError: item.reason?.message || "Transaction provider failed",
          }
    );
  }

  return [await getRuleSnapshot(rule)];
}

function getEvmNetworkByKey(networkKey) {
  return evmNetworks.find((network) => network.key === networkKey) || evmNetworks[0];
}

function formatEvmValue(value, symbol) {
  const wei = BigInt(value || "0");
  const integer = wei / 10n ** 18n;
  const fraction = wei % 10n ** 18n;
  return `${integer}.${fraction.toString().padStart(18, "0").slice(0, 6)} ${symbol}`;
}

function formatDecimalUnits(value, decimals = 18) {
  let raw = 0n;

  try {
    raw = BigInt(String(value || "0"));
  } catch {
    raw = 0n;
  }

  const scale = 10n ** BigInt(Math.max(0, Number(decimals || 0)));
  const integer = raw / scale;
  const fraction = raw % scale;
  const fractionText = fraction
    .toString()
    .padStart(Math.max(0, Number(decimals || 0)), "0")
    .replace(/0+$/, "")
    .slice(0, 6);

  return fractionText ? `${integer.toLocaleString("en-US")}.${fractionText}` : integer.toLocaleString("en-US");
}

function decimalAmount(value, decimals = 18) {
  const amount = toRawAmount(value);
  const scale = 10n ** BigInt(Math.max(0, Number(decimals || 0)));

  if (!scale) {
    return 0;
  }

  const whole = amount / scale;
  const fraction = amount % scale;

  if (!fraction) {
    return Number(whole);
  }

  const precision = Math.min(Math.max(0, Number(decimals || 0)), 12);
  const fractionText = fraction
    .toString()
    .padStart(Math.max(0, Number(decimals || 0)), "0")
    .slice(0, precision)
    .replace(/0+$/, "");

  return Number(`${whole}.${fractionText || "0"}`);
}

function priceCacheGet(key) {
  const cached = priceCache.get(key);

  if (!cached || Date.now() - cached.fetchedAt > priceCacheTtlMs) {
    return null;
  }

  return cached.value;
}

function priceCacheSet(key, value) {
  priceCache.set(key, {
    value,
    fetchedAt: Date.now(),
  });
  return value;
}

async function getAlchemySymbolPrice(symbol) {
  const apiKey = providerCredential("ALCHEMY_API_KEY");

  if (!apiKey || !symbol) {
    return null;
  }

  const response = await withProviderTelemetry("Alchemy Prices API", `price ${symbol}`, () =>
    fetch(`${serviceProtocol}://${alchemyPricesHost}/prices/v1/${apiKey}/tokens/by-symbol?symbols=${encodeURIComponent(symbol)}`)
  );

  if (!response.ok) {
    throw new Error(`Alchemy Prices HTTP ${response.status}`);
  }

  const payload = await response.json();
  const price = payload.data?.[0]?.prices?.find((item) => String(item.currency || "").toLowerCase() === "usd");
  const value = Number(price?.value);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return {
    priceUsd: value,
    priceProvider: "Alchemy Prices API",
    pricedAt: price.lastUpdatedAt || new Date().toISOString(),
  };
}

async function getDefiLlamaPrice(priceId) {
  if (!priceId) {
    return null;
  }

  const response = await withProviderTelemetry("DefiLlama Coins API", `price ${priceId}`, () =>
    fetch(`https://coins.llama.fi/prices/current/${priceId}`)
  );

  if (!response.ok) {
    throw new Error(`DefiLlama Prices HTTP ${response.status}`);
  }

  const payload = await response.json();
  const coin = payload.coins?.[priceId];
  const value = Number(coin?.price);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return {
    priceUsd: value,
    priceProvider: "DefiLlama Coins API",
    pricedAt: coin.timestamp ? new Date(Number(coin.timestamp) * 1000).toISOString() : new Date().toISOString(),
    priceConfidence: coin.confidence ?? null,
  };
}

async function getUsdPrice({ networkKey, tokenSymbol, tokenType }) {
  const symbol = String(tokenSymbol || "").toUpperCase();

  if (stablecoinSymbols.has(symbol)) {
    return {
      priceUsd: 1,
      priceProvider: "Stablecoin USD peg",
      pricedAt: new Date().toISOString(),
      priceConfidence: 0.95,
    };
  }

  const isNative = String(tokenType || "native").toLowerCase() === "native";
  const nativeSymbol = networkKey === "TRX" ? "TRX" : symbol;
  const cacheKey = `${networkKey || "UNKNOWN"}:${symbol}:${tokenType || ""}`;
  const cached = priceCacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  if (!isNative) {
    return null;
  }

  try {
    const alchemyPrice = await getAlchemySymbolPrice(nativeSymbol);

    if (alchemyPrice) {
      return priceCacheSet(cacheKey, alchemyPrice);
    }
  } catch {
    // DefiLlama fallback below.
  }

  try {
    return priceCacheSet(cacheKey, await getDefiLlamaPrice(nativePriceIds[networkKey] || nativePriceIds[nativeSymbol]));
  } catch {
    return null;
  }
}

async function enrichTransactionsWithUsd(items = []) {
  const enriched = [];
  const priceMemo = new Map();

  for (const tx of items) {
    const decimals = Number(tx.tokenDecimals ?? nativeDecimalsForNetwork(tx.networkKey));
    const tokenSymbol = tx.tokenSymbol || (tx.tokenType === "native" ? tx.networkKey : "");
    const priceKey = `${tx.networkKey || ""}:${tokenSymbol}:${tx.tokenType || ""}`;

    if (!priceMemo.has(priceKey)) {
      priceMemo.set(priceKey, await getUsdPrice({
        networkKey: tx.networkKey,
        tokenSymbol,
        tokenType: tx.tokenType,
      }));
    }

    const price = priceMemo.get(priceKey);
    const amount = decimalAmount(tx.rawValue, decimals);
    const usdValue = price ? amount * price.priceUsd : null;

    enriched.push({
      ...tx,
      amount,
      usdPrice: price?.priceUsd ?? null,
      usdValue: Number.isFinite(usdValue) ? Number(usdValue.toFixed(2)) : null,
      priceProvider: price?.priceProvider || "",
      pricedAt: price?.pricedAt || "",
      priceConfidence: price?.priceConfidence ?? null,
    });
  }

  return enriched;
}

function normalizeEvmTransactions({ result, network, address, provider }) {
  return result.map((tx) => ({
    hash: tx.hash,
    txHash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: formatEvmValue(tx.value, network.symbol),
    rawValue: tx.value,
    tokenSymbol: network.symbol,
    tokenType: "native",
    blockNumber: Number(tx.blockNumber),
    timestamp: Number(tx.timeStamp) * 1000,
    direction: tx.from?.toLowerCase() === address.toLowerCase() ? "out" : "in",
    status: tx.txreceipt_status === "1" ? "success" : "failed",
    fee: tx.gasUsed && tx.gasPrice ? formatEvmValue(String(BigInt(tx.gasUsed) * BigInt(tx.gasPrice)), network.symbol) : "",
    networkKey: network.key,
    networkName: network.name,
    explorerUrl: evmTransactionExplorerUrl(network, tx.hash),
    provider,
  }));
}

function evmTransactionExplorerUrl(network, txHash) {
  if (!txHash) {
    return "";
  }

  const host = evmExplorerHosts[network.key] || blockscoutHosts[network.key];
  if (!host) {
    return "";
  }

  return `${publicWebProtocol}://${host}/tx/${txHash}`;
}

function normalizeEvmTokenTransfers({ result, network, address, provider }) {
  return result.map((tx, index) => {
    const decimals = Number(tx.tokenDecimal || tx.tokenDecimals || 18);
    const symbol = tx.tokenSymbol || tx.symbol || "TOKEN";
    const tokenName = tx.tokenName || tx.name || symbol;
    const txHash = tx.hash || tx.transactionHash;
    const logIndex = tx.logIndex ?? tx.transactionIndex ?? index;

    return {
      hash: `${txHash}:${tx.contractAddress || "token"}:${logIndex}`,
      txHash,
      from: tx.from,
      to: tx.to,
      value: `${formatDecimalUnits(tx.value, decimals)} ${symbol}`,
      rawValue: tx.value,
      tokenSymbol: symbol,
      tokenName,
      tokenDecimals: decimals,
      tokenContract: tx.contractAddress || "",
      tokenType: "ERC20",
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp) * 1000,
      direction: tx.from?.toLowerCase() === address.toLowerCase() ? "out" : "in",
      status: "success",
      fee: "",
      networkKey: network.key,
      networkName: network.name,
      explorerUrl: evmTransactionExplorerUrl(network, txHash),
      provider,
    };
  });
}

function parseHexNumber(value) {
  try {
    return Number(BigInt(value || "0x0"));
  } catch {
    return 0;
  }
}

function parseHexBigIntString(value) {
  try {
    return String(BigInt(value || "0x0"));
  } catch {
    return "0";
  }
}

function normalizeAlchemyAssetTransfers({ result, network, address }) {
  const transfers = result?.transfers || [];

  return transfers.map((tx, index) => {
    const rawContract = tx.rawContract || {};
    const category = String(tx.category || "external").toLowerCase();
    const isToken = category === "erc20" || Boolean(rawContract.address);
    const decimals = parseHexNumber(rawContract.decimal) || (isToken ? 18 : 18);
    const rawValue = parseHexBigIntString(rawContract.value);
    const symbol = tx.asset || (isToken ? "TOKEN" : network.symbol);
    const txHash = tx.hash || tx.uniqueId || "";
    const timestamp = tx.metadata?.blockTimestamp ? Date.parse(tx.metadata.blockTimestamp) : null;
    const blockNumber = tx.blockNum ? parseHexNumber(tx.blockNum) : null;

    return {
      hash: `${txHash}:${rawContract.address || category}:${tx.uniqueId || index}`,
      txHash,
      from: tx.from,
      to: tx.to,
      value: `${formatDecimalUnits(rawValue, decimals)} ${symbol}`,
      rawValue,
      tokenSymbol: symbol,
      tokenName: symbol,
      tokenDecimals: decimals,
      tokenContract: rawContract.address || "",
      tokenType: isToken ? "ERC20" : "native",
      blockNumber,
      timestamp,
      direction: tx.from?.toLowerCase() === address.toLowerCase() ? "out" : "in",
      status: "success",
      fee: "",
      networkKey: network.key,
      networkName: network.name,
      explorerUrl: evmTransactionExplorerUrl(network, txHash),
      provider: "Alchemy Transfers API",
    };
  });
}

function compactHash(value, left = 10, right = 8) {
  const text = String(value || "");
  if (text.length <= left + right + 3) {
    return text;
  }

  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function latestTxDetails(latest, address) {
  const normalizedAddress = String(address || "").toLowerCase();
  const direction = latest?.direction || "";
  const from = latest?.from || "";
  const to = latest?.to || "";
  const counterparty =
    direction === "out"
      ? to
      : direction === "in"
        ? from
        : from.toLowerCase() === normalizedAddress
          ? to
          : from;

  return {
    latestTxId: latest?.txHash || latest?.hash || "",
    latestTxAt: latest?.timestamp || "",
    latestDirection: direction,
    latestValue: latest?.value || "",
    latestFrom: from,
    latestTo: to,
    latestCounterparty: counterparty,
    latestExplorerUrl: latest?.explorerUrl || "",
    latestProvider: latest?.provider || "",
    latestTokenType: latest?.tokenType || "",
    latestTokenSymbol: latest?.tokenSymbol || "",
    latestTokenName: latest?.tokenName || "",
  };
}

function normalizeCacheAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function transactionCacheKey(address, networkKey = "ALL") {
  return `${normalizeCacheAddress(address)}:${networkKey || "ALL"}`;
}

function riskCacheKey({ address, networkKey, mode }) {
  return `${normalizeCacheAddress(address)}:${networkKey || "UNKNOWN"}:${mode || "full"}:${riskModelVersion}`;
}

function spamTokenReason(tx) {
  const tokenType = String(tx?.tokenType || "").toLowerCase();
  if (!["erc20", "trc20", "trc10"].includes(tokenType)) {
    return "";
  }

  const text = [
    tx.value,
    tx.tokenSymbol,
    tx.tokenName,
    tx.tokenContract,
  ].filter(Boolean).join(" ").toLowerCase();

  if (!text) {
    return "";
  }

  if (/t\.me|telegram|claim|reward|airdrop|bonus|visit|www\.|https?:\/\//.test(text)) {
    return "promotional token text";
  }

  if (/\.life|\.xyz|\.top|\.vip|\.site|\.shop|\.online/.test(text)) {
    return "domain-like token text";
  }

  if (/[✅🎁🔥🚀💎]/u.test(text)) {
    return "emoji token text";
  }

  return "";
}

function withSpamTokenFlags(items) {
  return (items || []).map((tx) => {
    const reason = tx.spamReason || spamTokenReason(tx);
    return {
      ...tx,
      isSpamToken: Boolean(tx.isSpamToken || reason),
      spamReason: reason,
    };
  });
}

async function cacheWalletTransactions({ observedAddress, items }) {
  const addressKey = normalizeCacheAddress(observedAddress);
  const validItems = (items || []).filter((tx) => tx.hash && tx.networkKey);

  if (!addressKey || !validItems.length) {
    return { saved: 0 };
  }

  if (!usePostgres) {
    const fetchedAt = new Date().toISOString();
    const keys = new Set(["ALL", ...validItems.map((tx) => tx.networkKey || "UNKNOWN")]);

    for (const networkKey of keys) {
      const key = transactionCacheKey(addressKey, networkKey);
      const current = memoryTransactionCache.get(key)?.items || [];
      const nextByHash = new Map(current.map((tx) => [tx.hash, tx]));

      for (const tx of validItems.filter((item) => networkKey === "ALL" || item.networkKey === networkKey)) {
        nextByHash.set(tx.hash, tx);
      }

      memoryTransactionCache.set(key, {
        fetchedAt,
        items: [...nextByHash.values()]
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 500),
      });
    }

    return { saved: validItems.length };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const tx of validItems) {
      await client.query(
        `INSERT INTO wallet_transactions (
           observed_address,
           network_key,
           tx_hash,
           tx_timestamp,
           block_number,
           payload,
           provider,
           fetched_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
         ON CONFLICT (observed_address, network_key, tx_hash)
         DO UPDATE SET
           tx_timestamp = EXCLUDED.tx_timestamp,
           block_number = EXCLUDED.block_number,
           payload = EXCLUDED.payload,
           provider = EXCLUDED.provider,
           fetched_at = now()`,
        [
          addressKey,
          String(tx.networkKey || "UNKNOWN"),
          String(tx.hash),
          tx.timestamp ? Number(tx.timestamp) : null,
          Number.isFinite(Number(tx.blockNumber)) ? Number(tx.blockNumber) : null,
          JSON.stringify(tx),
          tx.provider || "",
        ]
      );
    }

    await client.query("COMMIT");
    return { saved: validItems.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readCachedWalletTransactions({
  observedAddress,
  networkKey,
  page = 1,
  limit = 25,
  includeDust = false,
}) {
  const addressKey = normalizeCacheAddress(observedAddress);

  if (!usePostgres) {
    const cache = memoryTransactionCache.get(transactionCacheKey(addressKey, networkKey || "ALL"));
    const offset = Math.max(0, (page - 1) * limit);
    const rows = (cache?.items || []).filter((tx) => includeDust || !tx.isDust).slice(offset, offset + limit);
    const items = withSpamTokenFlags(await enrichTransactionsWithUsd(rows));

    return {
      items,
      page,
      limit,
      hasMore: (cache?.items || []).length > offset + limit,
      provider: "Memory transaction cache",
      cacheHit: items.length > 0,
    };
  }

  const params = [addressKey, limit, Math.max(0, (page - 1) * limit)];
  let networkClause = "";

  if (networkKey && networkKey !== "ALL") {
    params.push(networkKey);
    networkClause = "AND network_key = $" + params.length;
  }

  const result = await pool.query(
    [
      "SELECT payload",
      "FROM wallet_transactions",
      "WHERE observed_address = $1",
      networkClause,
      "ORDER BY tx_timestamp DESC NULLS LAST, fetched_at DESC",
      "LIMIT $2 OFFSET $3",
    ].filter(Boolean).join(" "),
    params
  );
  const items = withSpamTokenFlags(await enrichTransactionsWithUsd(
    result.rows.map((row) => row.payload).filter((tx) => includeDust || !tx.isDust)
  ));

  return {
    items,
    page,
    limit,
    hasMore: result.rows.length === limit,
    provider: transactionCacheProviderName,
    cacheHit: items.length > 0,
  };
}

async function readFreshCachedWalletTransactions({
  observedAddress,
  networkKey,
  page = 1,
  limit = 25,
  includeDust = false,
  ttlMs = transactionCacheTtlMs,
}) {
  const addressKey = normalizeCacheAddress(observedAddress);

  if (!usePostgres) {
    const cache = memoryTransactionCache.get(transactionCacheKey(addressKey, networkKey || "ALL"));

    if (!cache?.fetchedAt || (cache.items || []).length < Math.min(limit, 5)) {
      return null;
    }

    const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();

    if (ageMs > ttlMs) {
      return null;
    }

    const cached = await readCachedWalletTransactions({ observedAddress, networkKey, page, limit, includeDust });

    return cached.cacheHit
      ? {
          ...cached,
          cacheFresh: true,
          cachedAt: cache.fetchedAt,
          cacheAgeMs: ageMs,
        }
      : null;
  }

  const params = [addressKey];
  let networkClause = "";

  if (networkKey && networkKey !== "ALL") {
    params.push(networkKey);
    networkClause = "AND network_key = $" + params.length;
  }

  const freshness = await pool.query(
    [
      "SELECT MAX(fetched_at) AS fetched_at, COUNT(*)::int AS count",
      "FROM wallet_transactions",
      "WHERE observed_address = $1",
      networkClause,
    ].filter(Boolean).join(" "),
    params
  );
  const row = freshness.rows[0];

  if (!row?.fetched_at || Number(row.count || 0) < Math.min(limit, 5)) {
    return null;
  }

  const ageMs = Date.now() - new Date(row.fetched_at).getTime();

  if (ageMs > ttlMs) {
    return null;
  }

  const cached = await readCachedWalletTransactions({ observedAddress, networkKey, page, limit, includeDust });

  return cached.cacheHit
    ? {
        ...cached,
        cacheFresh: true,
        cachedAt: row.fetched_at,
        cacheAgeMs: ageMs,
      }
    : null;
}

async function readCachedWalletRisk({ address, networkKey, mode }) {
  if (!usePostgres) {
    const row = memoryRiskCache.get(riskCacheKey({ address, networkKey, mode }));

    if (!row || row.payload?.riskModelVersion !== riskModelVersion) {
      return null;
    }

    const ageMs = Date.now() - new Date(row.calculatedAt).getTime();

    if (ageMs > riskCacheTtlMs) {
      memoryRiskCache.delete(riskCacheKey({ address, networkKey, mode }));
      return null;
    }

    return {
      ...row.payload,
      cacheHit: true,
      cachedAt: row.calculatedAt,
      cacheAgeMs: ageMs,
    };
  }

  const result = await pool.query(
    `SELECT payload, calculated_at
     FROM wallet_risk_cache
     WHERE observed_address = $1 AND network_key = $2 AND mode = $3`,
    [normalizeCacheAddress(address), networkKey || "UNKNOWN", mode || "full"]
  );
  const row = result.rows[0];

  if (!row || row.payload?.riskModelVersion !== riskModelVersion) {
    return null;
  }

  const ageMs = Date.now() - new Date(row.calculated_at).getTime();

  if (ageMs > riskCacheTtlMs) {
    return null;
  }

  return {
    ...row.payload,
    cacheHit: true,
    cachedAt: row.calculated_at,
    cacheAgeMs: ageMs,
  };
}

async function writeCachedWalletRisk({ address, networkKey, mode, payload }) {
  if (!usePostgres) {
    memoryRiskCache.set(riskCacheKey({ address, networkKey, mode }), {
      payload,
      calculatedAt: new Date().toISOString(),
    });
    return;
  }

  await pool.query(
    `INSERT INTO wallet_risk_cache (observed_address, network_key, mode, payload, calculated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (observed_address, network_key, mode)
     DO UPDATE SET payload = EXCLUDED.payload, calculated_at = now()`,
    [normalizeCacheAddress(address), networkKey || "UNKNOWN", mode || "full", JSON.stringify(payload)]
  );
}

async function readApiResponseCache(cacheKey, ttlMs) {
  if (!usePostgres) {
    const row = memoryApiResponseCache.get(cacheKey);

    if (!row) {
      return null;
    }

    const ageMs = Date.now() - new Date(row.fetchedAt).getTime();

    if (ageMs > ttlMs) {
      memoryApiResponseCache.delete(cacheKey);
      return null;
    }

    return {
      ...row.payload,
      cacheHit: true,
      cachedAt: row.fetchedAt,
      cacheAgeMs: ageMs,
    };
  }

  const result = await pool.query(
    `SELECT payload, fetched_at
     FROM api_response_cache
     WHERE cache_key = $1`,
    [cacheKey]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const ageMs = Date.now() - new Date(row.fetched_at).getTime();

  if (ageMs > ttlMs) {
    return null;
  }

  return {
    ...row.payload,
    cacheHit: true,
    cachedAt: row.fetched_at,
    cacheAgeMs: ageMs,
  };
}

async function writeApiResponseCache(cacheKey, payload) {
  if (!usePostgres) {
    memoryApiResponseCache.set(cacheKey, {
      payload,
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  await pool.query(
    `INSERT INTO api_response_cache (cache_key, payload, fetched_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (cache_key)
     DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [cacheKey, JSON.stringify(payload)]
  );
}

async function withApiResponseCache({ cacheKey, ttlMs, refresh = false, load }) {
  if (!refresh) {
    const cached = await readApiResponseCache(cacheKey, ttlMs);

    if (cached) {
      return cached;
    }
  }

  const payload = await load();
  await writeApiResponseCache(cacheKey, payload);
  return payload;
}

async function invalidateWalletRiskCache() {
  if (!usePostgres) {
    memoryRiskCache.clear();
    return;
  }

  await pool.query("DELETE FROM wallet_risk_cache");
}

async function invalidateDerivedAnalysisCache() {
  await invalidateWalletRiskCache();

  if (!usePostgres) {
    for (const key of memoryApiResponseCache.keys()) {
      if (key.startsWith("graph:") || key.startsWith("graph-neighbors:")) {
        memoryApiResponseCache.delete(key);
      }
    }
    return;
  }

  await pool.query(
    `DELETE FROM api_response_cache
     WHERE cache_key LIKE 'graph:%' OR cache_key LIKE 'graph-neighbors:%'`
  );
}

async function getTransactionsWithCache({
  address,
  networkKey,
  page = 1,
  limit = 25,
  fingerprint = "",
  includeDust = false,
  minAmountSun = tronDustMinSun,
  refresh = false,
}) {
  const useTron = networkKey === "TRX" || isTronAddress(address);
  const useBitcoin = networkKey === "BTC" || isBitcoinAddress(address);
  const useEvm = isEvmAddress(address);
  let live = null;
  let liveError = null;

  if (!refresh && !fingerprint) {
    const freshCached = await readFreshCachedWalletTransactions({ observedAddress: address, networkKey, page, limit, includeDust });

    if (freshCached) {
      return freshCached;
    }
  }

  try {
    if (useTron) {
      live = await getUnifiedTronTransactions({ address, limit, fingerprint, includeDust, minAmountSun });
    } else if (useBitcoin) {
      live = await getBitcoinTransactions({ address, page, limit, fingerprint });
    } else if (useEvm) {
      live =
        networkKey === "ALL"
          ? await getAllEvmTransactions({ address, page, limit })
          : await getEvmTransactions({ address, networkKey, page, limit });
    }

    if (live?.items?.length) {
      live = {
        ...live,
        items: withSpamTokenFlags(await enrichTransactionsWithUsd(live.items)),
      };
      await cacheWalletTransactions({ observedAddress: address, items: live.items });
    }
  } catch (error) {
    liveError = error;
  }

  if (!live && !useTron && !useBitcoin && !useEvm) {
    return {
      items: [],
      hasMore: false,
      providerRequired: true,
      message: "Transaction history provider is not configured for this network yet.",
    };
  }

  if (live?.providerRequired) {
    const cached = await readCachedWalletTransactions({ observedAddress: address, networkKey, page, limit, includeDust });
    return {
      ...live,
      ...cached,
      provider: live.provider,
      cacheFallback: cached.cacheHit,
      message: cached.cacheHit ? `Live provider is not configured. Showing ${transactionCacheProviderName} transactions.` : live.message,
    };
  }

  if (liveError) {
    const cached = await readCachedWalletTransactions({ observedAddress: address, networkKey, page, limit, includeDust });

    if (cached.cacheHit) {
      return {
        ...cached,
        errors: [liveError.message],
        cacheFallback: true,
        message: `Live provider failed. Showing ${transactionCacheProviderName} transactions.`,
      };
    }

    throw liveError;
  }

  const shouldReadMergedCache = live?.items?.length && !fingerprint;

  if (shouldReadMergedCache) {
    const cached = await readCachedWalletTransactions({ observedAddress: address, networkKey, page, limit, includeDust });

    return {
      ...live,
      items: cached.items.length ? cached.items : live.items,
      hasMore: live.hasMore || cached.hasMore,
      cacheSaved: live.items.length,
      cacheHit: cached.cacheHit,
      cacheProvider: cached.provider,
    };
  }

  return live || {
    items: [],
    page,
    limit,
    hasMore: false,
    provider: transactionCacheProviderName,
  };
}

function transactionDataQuality(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
  const cached = Boolean(result.cacheHit || result.cacheFallback);
  const unavailable = result.providerRequired === true && !(result.items || []).length;
  const warnings = [];

  if (result.cacheFallback) warnings.push("Live provider failed or is not configured; cached transactions are shown.");
  if (result.hasMore) warnings.push("More transactions are available through pagination.");
  if (errors.length) warnings.push("One or more providers returned an error; history may be partial.");
  if (unavailable) warnings.push("Transaction history source is not configured for this network.");

  return {
    dataMode: unavailable ? "unavailable" : cached ? "cached" : "live",
    sourceProvider: result.provider || result.cacheProvider || transactionCacheProviderName,
    retrievedAt: new Date().toISOString(),
    completeness: unavailable ? "unavailable" : errors.length ? "partial" : result.hasMore ? "paginated" : "current_page",
    cacheHit: Boolean(result.cacheHit),
    cacheFallback: Boolean(result.cacheFallback),
    providerRequired: Boolean(result.providerRequired),
    errors,
    warnings,
  };
}

function defaultNetworkKeyForAddress(address, fallback = "ETH") {
  if (isTronAddress(address)) return "TRX";
  if (isBitcoinAddress(address)) return "BTC";
  if (isEvmAddress(address)) return fallback || "ETH";
  return fallback || "UNKNOWN";
}

async function loadWalletTransactionsAnalysis({
  address,
  networkKey = "ETH",
  limit = 80,
  refresh = false,
  entityLabels = [],
}) {
  const effectiveNetworkKey = defaultNetworkKeyForAddress(address, networkKey);
  const transactions = await getTransactionsWithCache({
    address,
    networkKey: effectiveNetworkKey,
    page: 1,
    limit,
    refresh,
  });

  return {
    address,
    networkKey: effectiveNetworkKey,
    analysis: analyzeTransactions(address, transactions.items || [], entityLabels),
    itemCount: transactions.items?.length || 0,
    provider: transactions.provider || transactions.cacheProvider || transactionCacheProviderName,
    providerRequired: Boolean(transactions.providerRequired),
    cacheHit: Boolean(transactions.cacheHit || transactions.cacheFallback),
    errors: transactions.errors || [],
    hasMore: Boolean(transactions.hasMore),
  };
}

function sortChainCandidates(candidates = []) {
  return [...candidates]
    .filter((candidate) => candidate?.address)
    .sort((a, b) => {
      const probabilityDelta = Number(b.probability || 0) - Number(a.probability || 0);
      if (probabilityDelta) return probabilityDelta;
      return String(a.address || "").localeCompare(String(b.address || ""));
    });
}

async function buildMixerChainScan({
  address,
  networkKey = "ETH",
  depth = 2,
  maxPerHop = 4,
  limit = 80,
  refresh = false,
  saveEntities = true,
}) {
  const maxDepth = Math.min(4, Math.max(0, Number(depth || 2)));
  const perHopLimit = Math.min(8, Math.max(1, Number(maxPerHop || 4)));
  const txLimit = Math.min(100, Math.max(20, Number(limit || 80)));
  const effectiveNetworkKey = defaultNetworkKeyForAddress(address, networkKey);
  const scanStartedAt = new Date().toISOString();
  const visited = new Set([String(address || "").toLowerCase()]);
  const chain = [];
  const savedEntities = [];
  const existingEntities = [];
  const errors = [];
  const savedEntityKeys = new Set();
  let entityLabels = await readEntityLabels();
  let labelsChanged = false;

  const maybeSaveEntity = async (scanAddress, scanNetworkKey) => {
    if (!saveEntities) {
      return null;
    }

    const key = String(scanAddress || "").toLowerCase();

    if (!key || savedEntityKeys.has(key)) {
      return null;
    }

    savedEntityKeys.add(key);

    try {
      const result = await saveArkhamEntityLabelForAddress({
        address: scanAddress,
        networkKey: scanNetworkKey || "ALL",
        source: "arkham-chain-scan",
      });

      if (!result?.label) {
        return null;
      }

      if (result.status === "saved") {
        labelsChanged = true;
        savedEntities.push(result.label);
        entityLabels = await readEntityLabels();
      } else {
        existingEntities.push(result.label);
      }

      return result;
    } catch (error) {
      errors.push({
        address: scanAddress,
        networkKey: scanNetworkKey || "ALL",
        stage: "entity",
        error: error.message,
      });
      return null;
    }
  };

  await maybeSaveEntity(address, effectiveNetworkKey === "ALL" ? "ALL" : effectiveNetworkKey);

  const root = await loadWalletTransactionsAnalysis({
    address,
    networkKey: effectiveNetworkKey,
    limit: txLimit,
    refresh,
    entityLabels,
  });
  let frontier = sortChainCandidates(root.analysis?.exitCandidates || []).map((candidate) => ({
    ...candidate,
    parentAddress: address,
    depth: 1,
  }));

  for (let hop = 1; hop <= maxDepth && frontier.length; hop += 1) {
    const batch = [];

    for (const candidate of sortChainCandidates(frontier)) {
      const key = String(candidate.address || "").toLowerCase();

      if (!key || visited.has(key)) {
        continue;
      }

      visited.add(key);
      batch.push(candidate);

      if (batch.length >= perHopLimit) {
        break;
      }
    }

    if (!batch.length) {
      break;
    }

    const nextFrontier = [];

    for (const candidate of batch) {
      const candidateNetworkKey = defaultNetworkKeyForAddress(candidate.address, candidate.networkKey || effectiveNetworkKey);
      const entityResult = await maybeSaveEntity(candidate.address, candidateNetworkKey);

      try {
        const hopResult = await loadWalletTransactionsAnalysis({
          address: candidate.address,
          networkKey: candidateNetworkKey,
          limit: Math.min(txLimit, 80),
          refresh,
          entityLabels,
        });

        chain.push({
          address: candidate.address,
          parentAddress: candidate.parentAddress,
          depth: hop,
          networkKey: candidateNetworkKey,
          networkName: candidate.networkName || hopResult.networkKey,
          probability: Number(candidate.probability || 0),
          reason: candidate.reason || "",
          txHash: candidate.txHash || "",
          entityLabel: entityResult?.label || null,
          entityStatus: entityResult?.status || "",
          analysis: hopResult.analysis,
          itemCount: hopResult.itemCount,
          provider: hopResult.provider,
          cacheHit: hopResult.cacheHit,
          errors: hopResult.errors || [],
        });

        for (const nextCandidate of hopResult.analysis?.exitCandidates || []) {
          if (nextCandidate.address) {
            nextFrontier.push({
              ...nextCandidate,
              parentAddress: candidate.address,
              depth: hop + 1,
            });
          }
        }
      } catch (error) {
        errors.push({
          address: candidate.address,
          networkKey: candidateNetworkKey,
          stage: "transactions",
          error: error.message,
        });
        chain.push({
          address: candidate.address,
          parentAddress: candidate.parentAddress,
          depth: hop,
          networkKey: candidateNetworkKey,
          networkName: candidate.networkName || candidateNetworkKey,
          probability: Number(candidate.probability || 0),
          reason: candidate.reason || "",
          txHash: candidate.txHash || "",
          entityLabel: entityResult?.label || null,
          entityStatus: entityResult?.status || "",
          error: error.message,
        });
      }
    }

    frontier = nextFrontier;
  }

  if (labelsChanged) {
    await invalidateDerivedAnalysisCache();
  }

  const chainAnalyses = chain.map((item) => item.analysis).filter(Boolean);
  const maxMixerConfidence = Math.max(
    root.analysis?.summary?.mixerHeuristicConfidence || 0,
    ...chainAnalyses.map((item) => item.summary?.mixerHeuristicConfidence || 0)
  );

  return {
    address,
    networkKey: effectiveNetworkKey,
    root,
    analysis: {
      ...root.analysis,
      chain,
      savedEntities,
      existingEntities,
      chainScan: {
        startedAt: scanStartedAt,
        completedAt: new Date().toISOString(),
        maxDepth,
        maxPerHop: perHopLimit,
        checkedAddresses: 1 + chain.length,
        savedEntityCount: savedEntities.length,
        existingEntityCount: existingEntities.length,
        maxMixerConfidence,
        errors,
      },
    },
  };
}

function mixerChainScanReportSummary(report) {
  if (!report) {
    return null;
  }

  const { result: _result, ...summary } = report;
  return summary;
}

async function saveMixerChainScanReport({ result, params = {}, profileId = "default" }) {
  const now = new Date().toISOString();
  const analysis = result?.analysis || {};
  const scan = analysis.chainScan || {};
  const report = {
    id: makeId("mixscan"),
    profileId: normalizeProfileId(profileId),
    address: result.address,
    networkKey: result.networkKey,
    title: `Mixer chain scan ${compactHash(result.address)}`,
    params,
    summary: {
      riskScore: analysis.riskScore || 0,
      rootExitCandidates: analysis.exitCandidates?.length || 0,
      chainHops: analysis.chain?.length || 0,
      checkedAddresses: scan.checkedAddresses || 1 + (analysis.chain?.length || 0),
      savedEntityCount: scan.savedEntityCount || 0,
      existingEntityCount: scan.existingEntityCount || 0,
      maxMixerConfidence: scan.maxMixerConfidence || analysis.summary?.mixerHeuristicConfidence || 0,
      errorCount: scan.errors?.length || 0,
    },
    result,
    createdAt: now,
    updatedAt: now,
  };
  const reports = await readJson(mixerChainScansFile);
  const nextReports = [
    report,
    ...reports.filter((item) => item.id !== report.id),
  ].slice(0, 80);

  await writeJson(mixerChainScansFile, nextReports);
  return report;
}

async function listMixerChainScanReports({ address = "", networkKey = "", profileId = "default", limit = 10 } = {}) {
  const normalizedAddress = String(address || "").toLowerCase();
  const normalizedNetwork = String(networkKey || "").trim();
  const normalizedProfile = normalizeProfileId(profileId);
  const reports = await readJson(mixerChainScansFile);

  return reports
    .filter((report) => !normalizedProfile || belongsToProfile(report, normalizedProfile))
    .filter((report) => !normalizedAddress || String(report.address || "").toLowerCase() === normalizedAddress)
    .filter((report) => !normalizedNetwork || report.networkKey === normalizedNetwork || normalizedNetwork === "ALL")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.min(30, Math.max(1, Number(limit || 10))));
}

function alchemyEndpoint(networkKey) {
  const slug = alchemyNetworkSlugs[networkKey];
  const apiKey = providerCredential("ALCHEMY_API_KEY");

  if (!apiKey || !slug) {
    return "";
  }

  return `${serviceProtocol}://${slug}.${alchemyHostSuffix}/v2/${apiKey}`;
}

async function alchemyRpc(networkKey, method, params = []) {
  const endpoint = alchemyEndpoint(networkKey);

  if (!endpoint) {
    return {
      providerRequired: true,
      message: providerCredential("ALCHEMY_API_KEY")
        ? `Alchemy is not configured for network ${networkKey}`
        : "ALCHEMY_API_KEY is required for EVM token balances.",
    };
  }

  const response = await withProviderTelemetry("Alchemy JSON-RPC API", method, () => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  }));

  if (!response.ok) {
    const error = new Error(`Alchemy HTTP ${response.status}`);
    error.status = response.status;
    error.networkKey = networkKey;
    throw error;
  }

  const payload = await response.json();

  if (payload.error) {
    throw new Error(payload.error.message || "Alchemy RPC error");
  }

  return payload.result;
}

function formatTokenAmount(rawHex, decimals = 18) {
  let raw = 0n;

  try {
    raw = BigInt(rawHex || "0");
  } catch {
    raw = 0n;
  }

  const scale = 10n ** BigInt(Math.max(0, Number(decimals || 0)));
  const whole = raw / scale;
  const fraction = raw % scale;

  if (!fraction) {
    return whole.toLocaleString("en-US");
  }

  const fractionText = fraction
    .toString()
    .padStart(Number(decimals || 0), "0")
    .replace(/0+$/, "")
    .slice(0, 6);

  return `${whole.toLocaleString("en-US")}.${fractionText}`;
}

async function getAlchemyTokenMetadata(networkKey, contractAddress) {
  const cacheKey = `${networkKey}:${contractAddress.toLowerCase()}`;

  if (alchemyTokenMetadataCache.has(cacheKey)) {
    return alchemyTokenMetadataCache.get(cacheKey);
  }

  const metadata = await alchemyRpc(networkKey, "alchemy_getTokenMetadata", [contractAddress]);
  const normalized = {
    name: metadata?.name || "ERC-20 Token",
    symbol: metadata?.symbol || contractAddress.slice(0, 8),
    decimals: Number.isFinite(Number(metadata?.decimals)) ? Number(metadata.decimals) : 18,
    logo: metadata?.logo || "",
  };

  alchemyTokenMetadataCache.set(cacheKey, normalized);
  return normalized;
}

async function getAlchemyTokenBalances({ address, networkKey, limit = 40 }) {
  const network = getEvmNetworkByKey(networkKey);
  const result = await alchemyRpc(network.key, "alchemy_getTokenBalances", [address, "erc20"]);

  if (result?.providerRequired) {
    return {
      address,
      networkKey: network.key,
      networkName: network.name,
      tokens: [],
      provider: "Alchemy Token API",
      providerRequired: true,
      message: result.message,
    };
  }

  const allBalances = result?.tokenBalances || [];
  const nonZeroBalances = allBalances
    .filter((item) => item.tokenBalance && item.tokenBalance !== "0x0")
    .filter((item) => {
      try {
        return BigInt(item.tokenBalance) > 0n;
      } catch {
        return false;
      }
    })
    .slice(0, limit);
  const tokens = [];
  const errors = [];

  for (const item of nonZeroBalances) {
    try {
      const metadata = await getAlchemyTokenMetadata(network.key, item.contractAddress);
      tokens.push({
        key: item.contractAddress,
        contractAddress: item.contractAddress,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        logo: metadata.logo,
        balance: formatTokenAmount(item.tokenBalance, metadata.decimals),
        rawBalance: item.tokenBalance,
        tokenType: "ERC20",
        networkKey: network.key,
        networkName: network.name,
      });
    } catch (error) {
      errors.push(`${item.contractAddress}: ${error.message}`);
    }
  }

  return {
    address,
    networkKey: network.key,
    networkName: network.name,
    tokens: tokens.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    totalTokenCount: allBalances.length,
    nonZeroTokenCount: nonZeroBalances.length,
    hasMore: allBalances.length > nonZeroBalances.length,
    provider: "Alchemy Token API",
    providerRequired: false,
    errors: errors.slice(0, 8),
  };
}

async function getAggregatedAlchemyTokenBalances({ address, limit = 40 }) {
  const settled = await Promise.allSettled(
    evmNetworks.map((network) => getAlchemyTokenBalances({ address, networkKey: network.key, limit }))
  );
  const fulfilled = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const tokens = fulfilled
    .flatMap((result) => result.tokens || [])
    .sort((a, b) => {
      const networkCompare = (a.networkName || "").localeCompare(b.networkName || "");
      return networkCompare || (a.symbol || "").localeCompare(b.symbol || "");
    })
    .slice(0, limit);
  const warnings = settled
    .map((result, index) => result.status === "rejected" ? `${evmNetworks[index].name}: ${result.reason?.message || "Alchemy failed"}` : "")
    .filter(Boolean);

  return {
    address,
    networkKey: "ALL",
    networkName: "All EVM",
    tokens,
    totalTokenCount: fulfilled.reduce((sum, result) => sum + Number(result.totalTokenCount || 0), 0),
    nonZeroTokenCount: fulfilled.reduce((sum, result) => sum + Number(result.nonZeroTokenCount || 0), 0),
    shownTokenCount: tokens.length,
    hasMore: fulfilled.some((result) => result.hasMore) || tokens.length >= limit,
    provider: "Alchemy Token API",
    providerRequired: false,
    checkedNetworks: fulfilled.map((result) => result.networkName),
    warnings: warnings.slice(0, 10),
    errors: fulfilled.flatMap((result) => result.errors || []).slice(0, 8),
  };
}

async function getAlchemyNftsForOwner({ address, networkKey, limit = 24 }) {
  const network = getEvmNetworkByKey(networkKey);
  const slug = alchemyNetworkSlugs[network.key];
  const apiKey = providerCredential("ALCHEMY_API_KEY");

  if (!apiKey || !slug) {
    return {
      address,
      networkKey: network.key,
      networkName: network.name,
      nfts: [],
      provider: "Alchemy NFT API",
      providerRequired: true,
      message: apiKey ? `Alchemy NFT API is not configured for network ${network.key}` : "ALCHEMY_API_KEY is required for NFT exposure.",
    };
  }

  const params = new URLSearchParams({
    owner: address,
    withMetadata: "true",
    pageSize: String(Math.min(Math.max(1, limit), 100)),
  });
  const response = await withProviderTelemetry("Alchemy NFT API", `getNFTsForOwner ${network.key}`, () =>
    fetch(`${serviceProtocol}://${slug}.${alchemyHostSuffix}/nft/v3/${apiKey}/getNFTsForOwner?${params}`)
  );

  if (!response.ok) {
    throw new Error(`Alchemy NFT API HTTP ${response.status}`);
  }

  const payload = await response.json();
  const ownedNfts = Array.isArray(payload.ownedNfts) ? payload.ownedNfts : [];
  const nfts = ownedNfts.map((item) => {
    const contract = item.contract || {};
    const collection = item.collection || {};
    const image = item.image || {};
    const spamInfo = item.spamInfo || {};
    const name = item.name || item.title || collection.name || "NFT";

    return {
      key: `${contract.address || "contract"}:${item.tokenId || item.tokenIdHex || name}`,
      name,
      collectionName: collection.name || contract.name || "",
      contractAddress: contract.address || "",
      tokenId: item.tokenId || item.tokenIdHex || "",
      tokenType: contract.tokenType || item.tokenType || "NFT",
      balance: item.balance || "1",
      imageUrl: image.cachedUrl || image.thumbnailUrl || image.pngUrl || image.originalUrl || "",
      floorPriceUsd: item.floorPrice?.value || null,
      isSpam: Boolean(spamInfo.isSpam || collection.isSpam),
      spamReason: spamInfo.classifications?.join(", ") || "",
      rawMetadataUpdatedAt: item.timeLastUpdated || "",
    };
  });
  const spamCount = nfts.filter((item) => item.isSpam).length;

  return {
    address,
    networkKey: network.key,
    networkName: network.name,
    nfts,
    totalCount: payload.totalCount ?? nfts.length,
    shownCount: nfts.length,
    spamCount,
    pageKey: payload.pageKey || "",
    hasMore: Boolean(payload.pageKey),
    provider: "Alchemy NFT API",
    providerRequired: false,
    checkedAt: new Date().toISOString(),
  };
}

async function getAggregatedAlchemyNftsForOwner({ address, limit = 24 }) {
  const settled = await Promise.allSettled(
    evmNetworks.map((network) => getAlchemyNftsForOwner({ address, networkKey: network.key, limit }))
  );
  const fulfilled = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const nfts = fulfilled
    .flatMap((result) => (result.nfts || []).map((nft) => ({
      ...nft,
      networkKey: result.networkKey,
      networkName: result.networkName,
      key: `${result.networkKey}:${nft.key}`,
    })))
    .slice(0, limit);
  const warnings = settled
    .map((result, index) => result.status === "rejected" ? `${evmNetworks[index].name}: ${result.reason?.message || "Alchemy NFT failed"}` : "")
    .filter(Boolean);

  return {
    address,
    networkKey: "ALL",
    networkName: "All EVM",
    nfts,
    totalCount: fulfilled.reduce((sum, result) => sum + Number(result.totalCount || 0), 0),
    shownCount: nfts.length,
    spamCount: nfts.filter((item) => item.isSpam).length,
    hasMore: fulfilled.some((result) => result.hasMore) || nfts.length >= limit,
    provider: "Alchemy NFT API",
    providerRequired: false,
    checkedNetworks: fulfilled.map((result) => result.networkName),
    warnings: warnings.slice(0, 10),
    checkedAt: new Date().toISOString(),
  };
}

async function getAlchemyAssetTransfers({ address, networkKey, page, limit }) {
  const network = getEvmNetworkByKey(networkKey);
  const endpoint = alchemyEndpoint(network.key);

  if (!endpoint) {
    return {
      items: [],
      page,
      limit,
      hasMore: false,
      provider: "Alchemy Transfers API",
      providerRequired: true,
      message: providerCredential("ALCHEMY_API_KEY")
        ? `Alchemy Transfers is not configured for network ${network.key}`
        : "ALCHEMY_API_KEY is required for Alchemy Transfers.",
    };
  }

  const maxCount = `0x${Math.min(Math.max(1, limit), 100).toString(16)}`;
  const baseParams = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: alchemyTransferCategories,
    withMetadata: true,
    excludeZeroValue: true,
    maxCount,
    order: "desc",
  };
  const [outgoingResult, incomingResult] = await Promise.allSettled([
    alchemyRpc(network.key, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
    alchemyRpc(network.key, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
  ]);
  const successful = [outgoingResult, incomingResult]
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((value) => !value?.providerRequired);
  const errors = [outgoingResult, incomingResult]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "unknown Alchemy Transfers error");

  if (!successful.length) {
    throw new Error(errors.join(" | ") || "Alchemy Transfers failed");
  }

  const seen = new Set();
  const items = successful
    .flatMap((result) => normalizeAlchemyAssetTransfers({ result, network, address }))
    .filter((tx) => {
      const key = tx.hash || `${tx.txHash}:${tx.from}:${tx.to}:${tx.rawValue}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);

  return {
    items,
    page,
    limit,
    hasMore: successful.some((result) => result.pageKey),
    provider: "Alchemy Transfers API",
    providerRequired: false,
    errors,
  };
}

function explorerAccountParams({ action, address, page, limit, apiKey, chainId }) {
  const params = new URLSearchParams({
    module: "account",
    action,
    address,
    startblock: "0",
    endblock: "99999999",
    page: String(page),
    offset: String(limit),
    sort: "desc",
  });

  if (chainId) {
    params.set("chainid", chainId);
  }

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  return params;
}

async function getRoutescanTransactions({ address, networkKey, page, limit }) {
  const network = getEvmNetworkByKey(networkKey);
  const apiKey = providerCredential("ROUTESCAN_API_KEY");
  const params = explorerAccountParams({ action: "txlist", address, page, limit, apiKey });
  const url = `${serviceProtocol}://${routescanHost}/v2/network/mainnet/evm/${network.chainId}/etherscan/api?${params}`;
  const response = await scheduleRoutescanRequest(() =>
    withProviderTelemetry("Routescan API", `txlist ${network.key}`, () => fetch(url))
  );

  if (!response.ok) {
    throw new Error(`Routescan HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "0" && /chain not supported/i.test(payload.message || payload.result || "")) {
    return {
      items: [],
      page,
      limit,
      hasMore: false,
      provider: "Routescan API",
      providerRequired: false,
      skippedNetworks: [network.name],
    };
  }

  if (payload.status === "0" && payload.message !== "No transactions found") {
    throw new Error(payload.result || payload.message || "Routescan error");
  }

  const result = Array.isArray(payload.result) ? payload.result : [];

  return {
    items: normalizeEvmTransactions({ result, network, address, provider: "Routescan API" }),
    page,
    limit,
    hasMore: result.length === limit,
    provider: "Routescan API",
    providerRequired: false,
  };
}

function blockscoutBaseUrl(networkKey) {
  const envKey = `BLOCKSCOUT_${String(networkKey || "").toUpperCase()}_URL`;
  const fallbackHost = blockscoutHosts[networkKey];
  const fallbackUrl = fallbackHost ? `${blockscoutProtocol}://${fallbackHost}` : "";
  return (process.env[envKey] || fallbackUrl).replace(/\/$/, "");
}

async function getBlockscoutTransactions({ address, networkKey, page, limit }) {
  const network = getEvmNetworkByKey(networkKey);
  const baseUrl = blockscoutBaseUrl(network.key);

  if (!baseUrl) {
    return {
      items: [],
      page,
      limit,
      hasMore: false,
      provider: "Blockscout API",
      providerRequired: true,
      message: `Blockscout endpoint is not configured for ${network.key}. Set BLOCKSCOUT_${network.key}_URL.`,
      skippedNetworks: [network.name],
    };
  }

  const params = explorerAccountParams({
    action: "txlist",
    address,
    page,
    limit,
    apiKey: providerCredential("BLOCKSCOUT_API_KEY"),
  });

  const response = await withProviderTelemetry("Blockscout API", `txlist ${network.key}`, () => fetch(`${baseUrl}/api?${params}`));

  if (!response.ok) {
    throw new Error(`Blockscout HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "0" && !/no transactions found/i.test(String(payload.message || payload.result || ""))) {
    throw new Error(payload.result || payload.message || "Blockscout error");
  }

  const result = Array.isArray(payload.result) ? payload.result : [];

  return {
    items: normalizeEvmTransactions({ result, network, address, provider: "Blockscout API" }),
    page,
    limit,
    hasMore: result.length === limit,
    provider: "Blockscout API",
    providerRequired: false,
  };
}

async function getBlockscoutTokenTransfers({ address, networkKey, page, limit }) {
  const network = getEvmNetworkByKey(networkKey);
  const baseUrl = blockscoutBaseUrl(network.key);

  if (!baseUrl) {
    return {
      items: [],
      page,
      limit,
      hasMore: false,
      provider: "Blockscout API",
      providerRequired: true,
      message: `Blockscout endpoint is not configured for ${network.key}. Set BLOCKSCOUT_${network.key}_URL.`,
    };
  }

  const params = explorerAccountParams({
    action: "tokentx",
    address,
    page,
    limit,
    apiKey: providerCredential("BLOCKSCOUT_API_KEY"),
  });

  const response = await withProviderTelemetry("Blockscout Token API", `tokentx ${network.key}`, () => fetch(`${baseUrl}/api?${params}`));

  if (!response.ok) {
    throw new Error(`Blockscout token HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "0" && !/no transactions found/i.test(String(payload.message || payload.result || ""))) {
    throw new Error(payload.result || payload.message || "Blockscout token error");
  }

  const result = Array.isArray(payload.result) ? payload.result : [];

  return {
    items: normalizeEvmTokenTransfers({ result, network, address, provider: "Blockscout Token API" }),
    page,
    limit,
    hasMore: result.length === limit,
    provider: "Blockscout Token API",
    providerRequired: false,
  };
}

async function getEtherscanTokenTransfers({ address, networkKey, page, limit }) {
  const apiKey = providerCredential("ETHERSCAN_API_KEY");

  if (!apiKey) {
    return getBlockscoutTokenTransfers({ address, networkKey, page, limit });
  }

  const network = getEvmNetworkByKey(networkKey);
  const params = explorerAccountParams({ action: "tokentx", address, page, limit, apiKey, chainId: network.chainId });
  const response = await scheduleEtherscanRequest(() =>
    withProviderTelemetry("Etherscan Token API v2", `tokentx ${network.key}`, () => fetch(`${serviceProtocol}://${etherscanApiHost}/v2/api?${params}`))
  );

  if (!response.ok) {
    if (response.status === 429) {
      return getBlockscoutTokenTransfers({ address, networkKey, page, limit });
    }

    throw new Error(`Etherscan token HTTP ${response.status}`);
  }

  const payload = await response.json();
  const message = payload.result || payload.message || "Etherscan token error";

  if (payload.status === "0" && payload.message !== "No transactions found") {
    if (isEtherscanRateLimit(message) || isEtherscanUnsupportedChain(message)) {
      return getBlockscoutTokenTransfers({ address, networkKey, page, limit });
    }

    throw new Error(message);
  }

  const result = Array.isArray(payload.result) ? payload.result : [];

  return {
    items: normalizeEvmTokenTransfers({ result, network, address, provider: "Etherscan Token API v2" }),
    page,
    limit,
    hasMore: result.length === limit,
    provider: "Etherscan Token API v2",
    providerRequired: false,
  };
}

async function getEvmNativeTransactions({ address, networkKey, page, limit }) {
  const apiKey = providerCredential("ETHERSCAN_API_KEY");

  if (!apiKey) {
    const blockscout = await getBlockscoutTransactions({ address, networkKey, page, limit });

    if (!blockscout.providerRequired) {
      return blockscout;
    }

    return getRoutescanTransactions({ address, networkKey, page, limit });
  }

  const network = getEvmNetworkByKey(networkKey);
  const params = explorerAccountParams({ action: "txlist", address, page, limit, apiKey, chainId: network.chainId });
  let payload = {};

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await scheduleEtherscanRequest(() =>
      withProviderTelemetry("Etherscan API v2", `txlist ${network.key}`, () => fetch(`${serviceProtocol}://${etherscanApiHost}/v2/api?${params}`))
    );

    if (!response.ok) {
      if (response.status === 429) {
        try {
          return await getBlockscoutTransactions({ address, networkKey, page, limit });
        } catch {
          return getRoutescanTransactions({ address, networkKey, page, limit });
        }
      }

      throw new Error(`Etherscan HTTP ${response.status}`);
    }

    payload = await response.json();
    const message = payload.result || payload.message || "Etherscan error";

    if (payload.status !== "0" || payload.message === "No transactions found") {
      break;
    }

    if (isEtherscanRateLimit(message) && attempt < 2) {
      await sleep(etherscanRateLimitRetryMs * (attempt + 1));
      continue;
    }

    if (isEtherscanRateLimit(message) || isEtherscanUnsupportedChain(message)) {
      try {
        const blockscout = await getBlockscoutTransactions({ address, networkKey, page, limit });

        if (!blockscout.providerRequired) {
          return blockscout;
        }
      } catch {
        // Fall through to Routescan fallback.
      }

      return getRoutescanTransactions({ address, networkKey, page, limit });
    }

    const error = new Error(message);
    error.code = isEtherscanUnsupportedChain(message) ? "ETHERSCAN_UNSUPPORTED_CHAIN" : "ETHERSCAN_ERROR";
    error.networkName = network.name;
    throw error;
  }

  const result = Array.isArray(payload.result) ? payload.result : [];

  return {
    items: normalizeEvmTransactions({ result, network, address, provider: "Etherscan API v2" }),
    page,
    limit,
    hasMore: result.length === limit,
    provider: "Etherscan API v2",
    providerRequired: false,
  };
}

async function getEvmTransactions({ address, networkKey, page, limit }) {
  const [nativeResult, tokenResult, alchemyResult] = await Promise.allSettled([
    getEvmNativeTransactions({ address, networkKey, page, limit }),
    getEtherscanTokenTransfers({ address, networkKey, page, limit }),
    getAlchemyAssetTransfers({ address, networkKey, page, limit }),
  ]);
  const successful = [nativeResult, tokenResult, alchemyResult]
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((result) => result.providerRequired !== true);
  const errors = [nativeResult, tokenResult, alchemyResult]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "unknown provider error");

  if (!successful.length) {
    throw new Error(errors.join(" | ") || "EVM transaction providers failed");
  }

  const items = successful
    .flatMap((result) => result.items || [])
    .filter((tx, index, list) => {
      const key = `${tx.networkKey}:${tx.txHash || tx.hash}:${tx.tokenContract || ""}:${tx.from}:${tx.to}:${tx.rawValue}`;
      return list.findIndex((item) =>
        `${item.networkKey}:${item.txHash || item.hash}:${item.tokenContract || ""}:${item.from}:${item.to}:${item.rawValue}` === key
      ) === index;
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
  const providers = uniqueValues(successful.map((result) => result.provider).filter(Boolean));

  return {
    items,
    page,
    limit,
    hasMore: successful.some((result) => result.hasMore),
    provider: providers.join(" + ") || "EVM transaction providers",
    providerRequired: false,
    errors,
  };
}

async function getAllEvmTransactions({ address, page, limit }) {
  const apiKey = providerCredential("ETHERSCAN_API_KEY");
  const blockscoutNetworks = evmNetworks.filter((network) => blockscoutBaseUrl(network.key));

  if (!apiKey) {
    if (!blockscoutNetworks.length) {
      return {
        items: [],
        page,
        limit,
        hasMore: false,
        provider: "Blockscout API",
        providerRequired: true,
        message: "Для этой EVM-сети нет бесплатного Blockscout-источника полной истории адреса.",
        networks: [],
      };
    }

    const perNetworkLimit = Math.min(25, limit);
    const successful = [];
    const errors = [];

    for (const network of blockscoutNetworks) {
      try {
        const result = await getBlockscoutTransactions({
          address,
          networkKey: network.key,
          page,
          limit: perNetworkLimit,
        });

        if (!result.providerRequired) {
          successful.push(result);
        }
      } catch (error) {
        errors.push(`${network.name}: ${error.message || "unknown error"}`);
      }
    }

    const items = successful
      .flatMap((result) => result.items)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return {
      items,
      page,
      limit,
      hasMore: successful.some((result) => result.hasMore),
      provider: "Blockscout API",
      providerRequired: false,
      scannedNetworks: blockscoutNetworks.map((network) => network.name),
      networks: successful
        .filter((result) => result.items.length)
        .map((result) => ({
          networkName: result.items[0].networkName,
          count: result.items.length,
          hasMore: result.hasMore,
        })),
      errors,
    };
  }

  const perNetworkLimit = Math.min(25, limit);
  const scanNetworks = evmNetworks;

  const successful = [];
  const errors = [];
  const skippedNetworks = [];

  for (const network of scanNetworks) {
    try {
      const result = await getEvmTransactions({
        address,
        networkKey: network.key,
        page,
        limit: perNetworkLimit,
      });
      successful.push(result);
    } catch (error) {
      if (error.code === "ETHERSCAN_UNSUPPORTED_CHAIN") {
        skippedNetworks.push(network.name);
        continue;
      }

      errors.push(`${network.name}: ${error.message || "unknown error"}`);
    }
  }

  const items = successful
    .flatMap((result) => result.items)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
  const networks = successful
    .filter((result) => result.items.length)
    .map((result) => ({
      networkName: result.items[0].networkName,
      count: result.items.length,
      hasMore: result.hasMore,
    }));
  skippedNetworks.push(...successful.flatMap((result) => result.skippedNetworks || []));

  return {
    items,
    page,
    limit,
    hasMore: successful.some((result) => result.hasMore),
    provider: "Etherscan API v2 + Alchemy Transfers + Blockscout/Routescan fallbacks",
    providerRequired: false,
    scannedNetworks: scanNetworks.map((network) => network.name),
    skippedNetworks: [...new Set(skippedNetworks)],
    networks,
    errors,
  };
}

function sumBitcoinOutputs(outputs = [], address) {
  const target = String(address || "").toLowerCase();
  return outputs
    .filter((output) => String(output.scriptpubkey_address || output.addr || "").toLowerCase() === target)
    .reduce((sum, output) => sum + BigInt(output.value || 0), 0n);
}

function sumBitcoinInputs(inputs = [], address) {
  const target = String(address || "").toLowerCase();
  return inputs
    .map((input) => input.prevout || input.prev_out || {})
    .filter((prevout) => String(prevout.scriptpubkey_address || prevout.addr || "").toLowerCase() === target)
    .reduce((sum, prevout) => sum + BigInt(prevout.value || 0), 0n);
}

function firstBitcoinAddress(items = [], skipAddress = "") {
  const skip = String(skipAddress || "").toLowerCase();
  const item = items.find((value) => {
    const address = String(value || "").toLowerCase();
    return address && address !== skip;
  });
  return item || "";
}

function normalizeEsploraBitcoinTransactions({ result, address, provider, explorerBase }) {
  const target = String(address || "").toLowerCase();

  return (result || []).map((tx) => {
    const inputFromTarget = sumBitcoinInputs(tx.vin || [], address);
    const outputToTarget = sumBitcoinOutputs(tx.vout || [], address);
    const isOutgoing = inputFromTarget > 0n;
    const recipientOutputs = (tx.vout || []).filter((output) => String(output.scriptpubkey_address || "").toLowerCase() !== target);
    const sentToRecipients = recipientOutputs.reduce((sum, output) => sum + BigInt(output.value || 0), 0n);
    const amount = isOutgoing ? sentToRecipients : outputToTarget;
    const inputAddresses = (tx.vin || []).map((input) => input.prevout?.scriptpubkey_address || "");
    const outputAddresses = (tx.vout || []).map((output) => output.scriptpubkey_address || "");
    const from = isOutgoing ? address : firstBitcoinAddress(inputAddresses, address);
    const to = isOutgoing ? firstBitcoinAddress(outputAddresses, address) : address;
    const timestamp = tx.status?.block_time ? Number(tx.status.block_time) * 1000 : null;

    return {
      hash: tx.txid,
      txHash: tx.txid,
      from,
      to,
      value: `${formatBtc(amount)} BTC`,
      rawValue: String(amount),
      tokenSymbol: "BTC",
      tokenDecimals: 8,
      tokenType: "native",
      blockNumber: tx.status?.block_height || null,
      timestamp,
      direction: isOutgoing ? "out" : "in",
      status: tx.status?.confirmed ? "confirmed" : "mempool",
      fee: tx.fee ? `${formatBtc(tx.fee)} BTC` : "",
      networkKey: "BTC",
      networkName: "Bitcoin",
      explorerUrl: `${explorerBase}/tx/${tx.txid}`,
      provider,
    };
  });
}

function normalizeBlockchainBitcoinTransactions({ result, address }) {
  const target = String(address || "").toLowerCase();

  return (result || []).map((tx) => {
    const inputs = tx.inputs || [];
    const outputs = tx.out || [];
    const inputFromTarget = sumBitcoinInputs(inputs, address);
    const outputToTarget = sumBitcoinOutputs(outputs, address);
    const isOutgoing = inputFromTarget > 0n;
    const recipientOutputs = outputs.filter((output) => String(output.addr || "").toLowerCase() !== target);
    const sentToRecipients = recipientOutputs.reduce((sum, output) => sum + BigInt(output.value || 0), 0n);
    const amount = isOutgoing ? sentToRecipients : outputToTarget;
    const from = isOutgoing ? address : firstBitcoinAddress(inputs.map((input) => input.prev_out?.addr || ""), address);
    const to = isOutgoing ? firstBitcoinAddress(outputs.map((output) => output.addr || ""), address) : address;

    return {
      hash: tx.hash,
      txHash: tx.hash,
      from,
      to,
      value: `${formatBtc(amount)} BTC`,
      rawValue: String(amount),
      tokenSymbol: "BTC",
      tokenDecimals: 8,
      tokenType: "native",
      blockNumber: tx.block_height || null,
      timestamp: tx.time ? Number(tx.time) * 1000 : null,
      direction: isOutgoing ? "out" : "in",
      status: tx.block_height ? "confirmed" : "mempool",
      fee: tx.fee ? `${formatBtc(tx.fee)} BTC` : "",
      networkKey: "BTC",
      networkName: "Bitcoin",
      explorerUrl: `${blockchainExplorerBase}/transactions/btc/${tx.hash}`,
      provider: "Blockchain.com API",
    };
  });
}

async function getEsploraBitcoinTransactions({ address, baseUrl, provider, explorerBase, limit, fingerprint = "" }) {
  const boundedLimit = Math.min(25, Math.max(1, Number(limit || 25)));
  const suffix = fingerprint ? `/${encodeURIComponent(fingerprint)}` : "";
  const result = await bitcoinJson(provider, baseUrl, `/address/${encodeURIComponent(address)}/txs/chain${suffix}`);
  const items = normalizeEsploraBitcoinTransactions({ result, address, provider, explorerBase }).slice(0, boundedLimit);

  return {
    items,
    fingerprint: items.at(-1)?.txHash || "",
    hasMore: Array.isArray(result) && result.length >= boundedLimit,
    provider,
    providerRequired: false,
  };
}

async function getBlockchainBitcoinTransactions({ address, page, limit }) {
  const offset = Math.max(0, (Number(page || 1) - 1) * Number(limit || 25));
  const payload = await bitcoinJson(
    "Blockchain.com API",
    blockchainApiBase,
    `/rawaddr/${encodeURIComponent(address)}?limit=${Math.min(100, Math.max(1, Number(limit || 25)))}&offset=${offset}`
  );
  const items = normalizeBlockchainBitcoinTransactions({ result: payload.txs || [], address });

  return {
    items,
    hasMore: offset + items.length < Number(payload.n_tx || 0),
    provider: "Blockchain.com API",
    providerRequired: false,
  };
}

async function getBitcoinTransactions({ address, page, limit, fingerprint = "" }) {
  const results = await Promise.allSettled([
    getEsploraBitcoinTransactions({
      address,
      baseUrl: mempoolApiBase,
      provider: "Mempool.space API",
      explorerBase: mempoolExplorerBase,
      limit,
      fingerprint,
    }),
    getEsploraBitcoinTransactions({
      address,
      baseUrl: blockstreamApiBase,
      provider: "Blockstream Esplora API",
      explorerBase: blockstreamExplorerBase,
      limit,
      fingerprint,
    }),
    getBlockchainBitcoinTransactions({ address, page, limit }),
  ]);
  const successful = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((result) => result.providerRequired !== true);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "unknown Bitcoin provider error");

  if (!successful.length) {
    throw new Error(errors.join(" | ") || "Bitcoin transaction providers failed");
  }

  const items = successful
    .flatMap((result) => result.items || [])
    .filter((tx, index, list) => list.findIndex((item) => (item.txHash || item.hash) === (tx.txHash || tx.hash)) === index)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
  const providers = uniqueValues(successful.map((result) => result.provider).filter(Boolean));

  return {
    items,
    page,
    limit,
    fingerprint: successful.find((result) => result.fingerprint)?.fingerprint || items.at(-1)?.txHash || "",
    hasMore: successful.some((result) => result.hasMore),
    provider: providers.join(" + ") || "Bitcoin transaction providers",
    providerRequired: false,
    errors,
  };
}

async function getTronTransactions({ address, limit, fingerprint, includeDust = false, minAmountSun = tronDustMinSun }) {
  const params = new URLSearchParams({
    limit: String(limit),
    only_confirmed: "true",
    order_by: "block_timestamp,desc",
  });

  if (fingerprint) {
    params.set("fingerprint", fingerprint);
  }

  const payload = await tronGet(`/v1/accounts/${encodeURIComponent(address)}/transactions?${params}`);

  const allItems = (payload.data || []).map((tx) => {
      const contract = tx.raw_data?.contract?.[0];
      const value = contract?.parameter?.value || {};
      const amountSun = value.amount || 0;
      const ownerAddress = tronAddressFromHex(value.owner_address || "");
      const toAddress = tronAddressFromHex(value.to_address || "");
      const contractType = contract?.type || "UnknownContract";
      const isNativeTransfer = contractType === "TransferContract";
      const assetName = decodeTronAssetName(value.asset_name);
      const tokenSymbol = isNativeTransfer ? "TRX" : assetName || "Token*";
      const displayValue = isNativeTransfer
        ? `${formatTrx(amountSun)} TRX`
        : `${formatTrx(amountSun)} ${tokenSymbol}`;

      return {
        hash: tx.txID,
        from: ownerAddress,
        to: toAddress,
        value: displayValue,
        rawValue: String(amountSun),
        tokenSymbol,
        tokenType: isNativeTransfer ? "native" : "TRC10",
        contractType,
        isDust: isNativeTransfer && amountSun < minAmountSun,
        blockNumber: tx.blockNumber || null,
        timestamp: tx.block_timestamp || null,
        direction: ownerAddress === address ? "out" : "in",
        status: tx.ret?.[0]?.contractRet || "unknown",
        fee: tx.fee ? `${formatTrx(tx.fee)} TRX` : "",
        networkName: "TRON",
        explorerUrl: `${publicWebProtocol}://${tronscanHost}/#/transaction/${tx.txID}`,
        networkKey: "TRX",
      };
    });
  const items = includeDust ? allItems : allItems.filter((tx) => !tx.isDust);
  const dustFilteredCount = allItems.length - items.length;

  return {
    items,
    dustFilteredCount,
    dustMinAmount: `${formatTrx(minAmountSun)} TRX`,
    fingerprint: payload.meta?.fingerprint || "",
    hasMore: Boolean(payload.meta?.fingerprint),
    provider: "TRON public API (без API-ключа)",
  };
}

function normalizeTronTrc20Transfers({ result, address }) {
  return result.map((tx, index) => {
    const tokenInfo = tx.token_info || {};
    const decimals = Number(tokenInfo.decimals ?? tx.token_decimal ?? 6);
    const symbol = tokenInfo.symbol || tx.token_symbol || "TRC20";
    const tokenName = tokenInfo.name || tx.token_name || symbol;
    const txHash = tx.transaction_id || tx.txID || tx.hash;
    const from = tx.from || "";
    const to = tx.to || "";

    return {
      hash: `${txHash}:${tokenInfo.address || tx.contract_address || "trc20"}:${index}`,
      txHash,
      from,
      to,
      value: `${formatDecimalUnits(tx.value || tx.quant || "0", decimals)} ${symbol}`,
      rawValue: String(tx.value || tx.quant || "0"),
      tokenSymbol: symbol,
      tokenName,
      tokenDecimals: decimals,
      tokenContract: tokenInfo.address || tx.contract_address || "",
      tokenType: "TRC20",
      blockNumber: tx.block_number || tx.blockNumber || null,
      timestamp: tx.block_timestamp || tx.timestamp || null,
      direction: from === address ? "out" : "in",
      status: "success",
      fee: "",
      networkName: "TRON",
      explorerUrl: `${publicWebProtocol}://${tronscanHost}/#/transaction/${txHash}`,
      networkKey: "TRX",
      provider: "TRON public TRC20 API (без API-ключа)",
    };
  });
}

async function getTronTrc20Transactions({
  address,
  limit,
  fingerprint = "",
  minTimestamp = null,
  maxTimestamp = null,
  orderBy = "block_timestamp,desc",
}) {
  const params = new URLSearchParams({
    limit: String(limit),
    only_confirmed: "true",
    order_by: orderBy,
  });

  if (fingerprint) {
    params.set("fingerprint", fingerprint);
  }

  if (minTimestamp !== null && minTimestamp !== "" && Number.isFinite(Number(minTimestamp))) {
    params.set("min_timestamp", String(Math.max(0, Math.trunc(Number(minTimestamp)))));
  }

  if (maxTimestamp !== null && maxTimestamp !== "" && Number.isFinite(Number(maxTimestamp))) {
    params.set("max_timestamp", String(Math.max(0, Math.trunc(Number(maxTimestamp)))));
  }

  const payload = await tronGet(`/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params}`);
  const items = normalizeTronTrc20Transfers({ result: payload.data || [], address });

  return {
    items,
    fingerprint: payload.meta?.fingerprint || "",
    hasMore: Boolean(payload.meta?.fingerprint),
    provider: "TRON public TRC20 API (без API-ключа)",
  };
}

async function getUnifiedTronTransactions({ address, limit, fingerprint, includeDust = false, minAmountSun = tronDustMinSun }) {
  const [nativeResult, trc20Result] = await Promise.allSettled([
    getTronTransactions({ address, limit, fingerprint, includeDust, minAmountSun }),
    getTronTrc20Transactions({ address, limit, fingerprint }),
  ]);
  const successful = [nativeResult, trc20Result].filter((result) => result.status === "fulfilled").map((result) => result.value);
  const errors = [nativeResult, trc20Result]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "unknown TRON provider error");

  if (!successful.length) {
    throw new Error(errors.join(" | ") || "TRON transaction providers failed");
  }

  const native = nativeResult.status === "fulfilled" ? nativeResult.value : {};
  const trc20 = trc20Result.status === "fulfilled" ? trc20Result.value : {};
  const items = successful
    .flatMap((result) => result.items || [])
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);

  return {
    items,
    dustFilteredCount: native.dustFilteredCount || 0,
    dustMinAmount: native.dustMinAmount || `${formatTrx(minAmountSun)} TRX`,
    fingerprint: native.fingerprint || trc20.fingerprint || "",
    hasMore: Boolean(native.hasMore || trc20.hasMore),
    provider: "TRON public API + TRC20 API (без API-ключа)",
    errors,
  };
}

function isTronAddress(address) {
  return /^T[A-Za-z0-9]{25,40}$/.test(address || "");
}

function isEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "");
}

function normalizeSupportedAddress(value) {
  const address = String(value || "").trim();
  if (isEvmAddress(address)) return address.toLowerCase();
  if (isTronAddress(address) || isBitcoinAddress(address)) return address;
  return "";
}

function traceBaseHash(tx) {
  return String(tx?.txHash || tx?.hash || "").split(":")[0];
}

function traceDecimalToRaw(value, decimals = 6) {
  const normalized = String(value ?? "").trim().replace(/,/g, ".");

  if (!normalized) {
    return null;
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Amount must be a positive decimal number.");
  }

  const safeDecimals = Math.max(0, Math.min(30, Number(decimals || 0)));
  const [whole = "0", fraction = ""] = normalized.split(".");
  const paddedFraction = fraction.padEnd(safeDecimals, "0").slice(0, safeDecimals);
  return BigInt(whole || "0") * 10n ** BigInt(safeDecimals) + BigInt(paddedFraction || "0");
}

function traceAmountPayload(rawValue, decimals = 6) {
  const raw = toRawAmount(rawValue);
  return {
    raw: raw.toString(),
    value: decimalAmount(raw.toString(), decimals),
    formatted: formatDecimalUnits(raw.toString(), decimals),
  };
}

function traceEntityForAddress(entityLabels, address, networkKey = "TRX") {
  const normalized = String(address || "").toLowerCase();
  const candidates = entityLabels
    .filter((label) => String(label.address || "").toLowerCase() === normalized)
    .filter((label) => ["ALL", "UNKNOWN", networkKey].includes(label.networkKey || "UNKNOWN"))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const label = candidates[0];

  if (!label) {
    return null;
  }

  return {
    id: label.id,
    name: label.name || "Known entity",
    category: normalizeEntityCategory(label.category),
    confidence: Number(label.confidence || 0),
    source: label.source || "local entity labels",
    notes: label.notes || "",
  };
}

function traceTokenMatches(tx, { symbol = "", contract = "" } = {}) {
  const expectedSymbol = String(symbol || "").trim().toUpperCase();
  const expectedContract = String(contract || "").trim().toLowerCase();
  const actualSymbol = String(tx?.tokenSymbol || "").trim().toUpperCase();
  const actualContract = String(tx?.tokenContract || "").trim().toLowerCase();

  if (expectedContract) {
    return actualContract === expectedContract;
  }

  return !expectedSymbol || actualSymbol === expectedSymbol;
}

async function loadTronTraceWindow({
  address,
  minTimestamp,
  maxTimestamp,
  maxPages = 3,
  pageLimit = 200,
  stopWhen = null,
}) {
  const items = [];
  const seen = new Set();
  let fingerprint = "";
  let pagesLoaded = 0;
  let providerHasMore = false;
  let stoppedEarly = false;

  while (pagesLoaded < maxPages) {
    const result = await getTronTrc20Transactions({
      address,
      limit: pageLimit,
      fingerprint,
      minTimestamp,
      maxTimestamp,
      orderBy: "block_timestamp,asc",
    });

    for (const tx of result.items || []) {
      const timestamp = Number(tx.timestamp || 0);
      const key = [traceBaseHash(tx), tx.from, tx.to, tx.rawValue, tx.tokenContract, timestamp].join(":");

      if (
        seen.has(key) ||
        (minTimestamp !== null && minTimestamp !== "" && Number.isFinite(Number(minTimestamp)) && timestamp < Number(minTimestamp)) ||
        (maxTimestamp !== null && maxTimestamp !== "" && Number.isFinite(Number(maxTimestamp)) && timestamp > Number(maxTimestamp))
      ) {
        continue;
      }

      seen.add(key);
      items.push(tx);
    }

    pagesLoaded += 1;
    providerHasMore = Boolean(result.hasMore && result.fingerprint);

    if (typeof stopWhen === "function" && items.some((tx) => stopWhen(tx))) {
      stoppedEarly = true;
      break;
    }

    if (!providerHasMore || result.fingerprint === fingerprint) {
      break;
    }

    fingerprint = result.fingerprint;
  }

  return {
    items: items.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)),
    pagesLoaded,
    truncated: !stoppedEarly && providerHasMore && pagesLoaded >= maxPages,
    stoppedEarly,
    provider: "TRON public TRC20 API (без API-ключа)",
  };
}

function traceConfidence({ similarity, delayMs, incomingCount, outgoingCount, alternatives }) {
  const delayHours = Math.max(0, Number(delayMs || 0) / (60 * 60 * 1000));
  const timeScore = Math.max(0, 22 - Math.min(22, delayHours * 2));
  const activityPenalty = Math.min(28, Math.max(0, outgoingCount - 3) * 1.4);
  const comminglingPenalty = Math.min(20, Math.max(0, incomingCount) * 4);
  const alternativePenalty = Math.min(15, Math.max(0, alternatives) * 2);
  return Math.max(
    15,
    Math.min(92, Math.round(28 + Number(similarity || 0) * 0.42 + timeScore - activityPenalty - comminglingPenalty - alternativePenalty))
  );
}

function rescaleTraceRawAmount(rawValue, fromDecimals, toDecimals) {
  const raw = toRawAmount(rawValue);
  const sourceDecimals = Math.max(0, Number(fromDecimals || 0));
  const targetDecimals = Math.max(0, Number(toDecimals || 0));

  if (sourceDecimals === targetDecimals) {
    return raw;
  }

  if (sourceDecimals < targetDecimals) {
    return raw * (10n ** BigInt(targetDecimals - sourceDecimals));
  }

  return raw / (10n ** BigInt(sourceDecimals - targetDecimals));
}

function traceExitType(entity) {
  if (!entity) return null;
  const text = [entity.name, entity.category, entity.notes, entity.source]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/mixer|tornado|mixing/.test(text)) return "mixer";
  if (/exchange|binance|okx|bybit|kucoin|kraken|coinbase|gate\.io|huobi|htx|mexc/.test(text)) return "exchange";
  if (/bridge|wormhole|allbridge|multichain/.test(text)) return "bridge";
  if (/dex|router|swap|justswap|sunswap|uniswap/.test(text)) return "dex";
  if (/payment|merchant|processor|pay/.test(text)) return "payment_service";
  if (/casino|gambl|betting|bet\b/.test(text)) return "gambling";
  if (/sanction|ofac/.test(text)) return "sanctioned_entity";
  if (/scam|fraud|phish|steal/.test(text)) return "reported_illicit";
  return "known_entity";
}

function detectAttributionNetwork(address) {
  if (isTronAddress(address)) return "TRX";
  if (isBitcoinAddress(address)) return "BTC";
  if (isEvmAddress(address)) return "ETH";
  return "UNKNOWN";
}

function attributionMatch(label) {
  return {
    id: label.id,
    name: label.name || "Known entity",
    category: normalizeEntityCategory(label.category),
    networkKey: label.networkKey || "UNKNOWN",
    confidence: Number(label.confidence || 0),
    source: label.source || "local entity labels",
    notes: label.notes || "",
    serviceType: traceExitType(label),
    externalUrl: label.externalUrl || "",
    evidenceLevel: label.evidenceLevel || "local_database_label",
    checkedAt: label.checkedAt || label.updatedAt || label.createdAt || "",
  };
}

async function traceTronFunds({
  address,
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
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const startTimestamp = Number.isFinite(Date.parse(startAt)) ? Date.parse(startAt) : now - 90 * 24 * 60 * 60 * 1000;
  const endTimestamp = Number.isFinite(Date.parse(endAt)) ? Date.parse(endAt) : now;

  if (!isTronAddress(address)) {
    throw new Error("Fund tracing currently requires a valid TRON address.");
  }

  if (endTimestamp <= startTimestamp) {
    throw new Error("End date must be later than start date.");
  }

  const safeDepth = Math.max(1, Math.min(6, Number(depth || 3)));
  const safeHopWindowHours = Math.max(1, Math.min(24 * 30, Number(hopWindowHours || 72)));
  const safeMaxBranches = Math.max(1, Math.min(12, Number(maxBranches || 8)));
  const safeMaxSeeds = Math.max(1, Math.min(100, Number(maxSeeds || 20)));
  const normalizedHash = String(seedTxHash || "").trim().toLowerCase();
  const normalizedSymbol = String(tokenSymbol || "USDT").trim().toUpperCase() || "USDT";
  const entityLabels = await readEntityLabels();
  const rootWindow = await loadTronTraceWindow({
    address,
    minTimestamp: startTimestamp,
    maxTimestamp: endTimestamp,
    maxPages: 5,
    stopWhen: normalizedHash
      ? (tx) => traceBaseHash(tx).toLowerCase() === normalizedHash
      : null,
  });
  let seedCandidates = rootWindow.items.filter(
    (tx) => tx.from === address && traceTokenMatches(tx, { symbol: normalizedSymbol })
  );

  if (normalizedHash) {
    seedCandidates = seedCandidates.filter((tx) => traceBaseHash(tx).toLowerCase() === normalizedHash);
  }

  if (amount !== "" && amount !== null && amount !== undefined) {
    seedCandidates = seedCandidates.filter((tx) => {
      const expected = traceDecimalToRaw(amount, Number(tx.tokenDecimals ?? 6));
      return expected === toRawAmount(tx.rawValue);
    });
  }

  const allSeedCount = seedCandidates.length;
  const seeds = seedCandidates.slice(0, safeMaxSeeds);

  if (!seeds.length) {
    return {
      reportId: makeId("fund-trace"),
      generatedAt,
      status: "not_found",
      rootAddress: address,
      networkKey: "TRX",
      query: {
        tokenSymbol: normalizedSymbol,
        startAt: new Date(startTimestamp).toISOString(),
        endAt: new Date(endTimestamp).toISOString(),
        seedTxHash: normalizedHash,
        amount: String(amount || ""),
        depth: safeDepth,
        hopWindowHours: safeHopWindowHours,
      },
      summary: {
        seedTransfersFound: 0,
        message: "В заданном периоде исходящие переводы с такими параметрами не найдены.",
      },
      steps: [],
      endpoints: [],
      comparisons: [],
      convergences: [],
      exitPoints: [],
      assetTransitions: [],
      facts: [],
      hypotheses: [],
      limitations: [
        "Проверьте сеть, даты, сумму и хеш транзакции.",
        rootWindow.truncated ? "Провайдер вернул не всю историю за период; сузьте даты." : "",
      ].filter(Boolean),
      provider: rootWindow.provider,
    };
  }

  const steps = [];
  const endpoints = [];
  const comparisons = [];
  const queue = [];
  const warnings = [];
  const assetTransitions = [];
  let stepSequence = 0;
  let endpointSequence = 0;
  let comparisonSequence = 0;
  let providerPagesLoaded = rootWindow.pagesLoaded;
  let providerTruncated = rootWindow.truncated;
  const maxTraceNodes = tronTraceMaxNodes;

  const addEndpoint = ({ item, address: endpointAddress, status, entity = null, note = "" }) => {
    const amountPayload = traceAmountPayload(item.amountRaw, item.tokenDecimals);
    endpoints.push({
      id: `endpoint-${++endpointSequence}`,
      address: endpointAddress,
      status,
      note,
      hop: item.hop,
      tokenSymbol: item.tokenSymbol,
      tokenContract: item.tokenContract,
      amount: amountPayload.value,
      amountFormatted: amountPayload.formatted,
      amountRaw: amountPayload.raw,
      confidence: item.pathConfidence,
      entity,
      originRecipientAddress: item.originRecipientAddress || null,
      lastTransactionHash: item.lastTransactionHash,
      lastTimestamp: item.receivedAt ? new Date(item.receivedAt).toISOString() : null,
      pathAddresses: item.pathAddresses || [],
      pathStepIds: item.pathStepIds,
    });
  };

  for (const seed of seeds) {
    const rawAmount = toRawAmount(seed.rawValue);
    const decimals = Number(seed.tokenDecimals ?? 6);
    const amountPayload = traceAmountPayload(rawAmount, decimals);
    const destinationEntity = traceEntityForAddress(entityLabels, seed.to, "TRX");
    const step = {
      id: `step-${++stepSequence}`,
      parentStepId: null,
      pathId: `path-${stepSequence}`,
      hop: 1,
      relation: "direct_fact",
      confidence: 100,
      sourceAddress: seed.from,
      destinationAddress: seed.to,
      originRecipientAddress: seed.to,
      originSeedTransactionHash: traceBaseHash(seed),
      transactionHash: traceBaseHash(seed),
      explorerUrl: seed.explorerUrl,
      timestamp: new Date(Number(seed.timestamp || 0)).toISOString(),
      tokenSymbol: seed.tokenSymbol,
      tokenContract: seed.tokenContract,
      transactionAmount: amountPayload.value,
      transactionAmountFormatted: amountPayload.formatted,
      transactionAmountRaw: amountPayload.raw,
      attributedAmount: amountPayload.value,
      attributedAmountFormatted: amountPayload.formatted,
      attributedAmountRaw: amountPayload.raw,
      destinationEntity,
      activity: null,
      reason: "Прямой перевод подтверждён записью блокчейна.",
    };
    steps.push(step);

    const queueItem = {
      address: seed.to,
      originRecipientAddress: seed.to,
      originSeedTransactionHash: traceBaseHash(seed),
      amountRaw: rawAmount,
      tokenDecimals: decimals,
      tokenSymbol: seed.tokenSymbol,
      tokenContract: seed.tokenContract,
      hop: 1,
      receivedAt: Number(seed.timestamp || 0),
      lastTransactionHash: traceBaseHash(seed),
      parentStepId: step.id,
      pathId: step.pathId,
      pathAddresses: [seed.from, seed.to],
      pathStepIds: [step.id],
      pathConfidence: 100,
    };

    if (destinationEntity) {
      addEndpoint({
        item: queueItem,
        address: seed.to,
        status: "known_entity",
        entity: destinationEntity,
        note: "Адрес совпал с записью в локальной базе организаций/рисков.",
      });
    } else if (safeDepth === 1) {
      addEndpoint({
        item: queueItem,
        address: seed.to,
        status: "depth_limit",
        note: "Проверка остановлена на выбранной глубине.",
      });
    } else {
      queue.push(queueItem);
    }
  }

  let expandedNodes = 0;

  while (queue.length && expandedNodes < maxTraceNodes) {
    const item = queue.shift();
    expandedNodes += 1;
    const hopEndTimestamp = Math.min(
      endTimestamp,
      item.receivedAt + safeHopWindowHours * 60 * 60 * 1000
    );

    if (hopEndTimestamp <= item.receivedAt) {
      addEndpoint({
        item,
        address: item.address,
        status: "time_limit",
        note: "После поступления не осталось времени в выбранном периоде проверки.",
      });
      continue;
    }

    const nextWindow = await loadTronTraceWindow({
      address: item.address,
      minTimestamp: item.receivedAt,
      maxTimestamp: hopEndTimestamp,
      maxPages: 3,
    });
    providerPagesLoaded += nextWindow.pagesLoaded;
    providerTruncated = providerTruncated || nextWindow.truncated;
    const sameToken = nextWindow.items.filter((tx) =>
      traceTokenMatches(tx, { symbol: item.tokenSymbol, contract: item.tokenContract })
    );
    const incoming = sameToken.filter((tx) => tx.to === item.address && traceBaseHash(tx) !== item.lastTransactionHash);
    const outgoing = sameToken
      .filter((tx) => tx.from === item.address && Number(tx.timestamp || 0) >= item.receivedAt)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const supportedStablecoins = new Set(["USDT", "USDC", "USDD"]);
    const otherStablecoinCandidates = nextWindow.items
      .filter((tx) => {
        const symbol = String(tx.tokenSymbol || "").toUpperCase();
        return tx.from === item.address
          && Number(tx.timestamp || 0) >= item.receivedAt
          && supportedStablecoins.has(symbol)
          && !traceTokenMatches(tx, { symbol: item.tokenSymbol, contract: item.tokenContract });
      })
      .map((tx) => {
        const candidateDecimals = Number(tx.tokenDecimals ?? 6);
        const candidateRaw = toRawAmount(tx.rawValue);
        const comparableRaw = rescaleTraceRawAmount(candidateRaw, candidateDecimals, item.tokenDecimals);
        return {
          tx,
          candidateRaw,
          candidateDecimals,
          similarity: amountSimilarityPercent(item.amountRaw, comparableRaw),
          delayMs: Number(tx.timestamp || 0) - item.receivedAt,
        };
      })
      .filter((candidate) => candidate.similarity >= 85 && candidate.delayMs <= 12 * 60 * 60 * 1000)
      .sort((a, b) => b.similarity - a.similarity || a.delayMs - b.delayMs)
      .slice(0, 12);

    for (const candidate of otherStablecoinCandidates) {
      const amountPayload = traceAmountPayload(candidate.candidateRaw, candidate.candidateDecimals);
      assetTransitions.push({
        id: `asset-transition-${assetTransitions.length + 1}`,
        hop: item.hop + 1,
        sourceAddress: item.address,
        destinationAddress: candidate.tx.to,
        incomingTransactionHash: item.lastTransactionHash,
        transactionHash: traceBaseHash(candidate.tx),
        explorerUrl: candidate.tx.explorerUrl,
        timestamp: new Date(Number(candidate.tx.timestamp || 0)).toISOString(),
        fromTokenSymbol: item.tokenSymbol,
        fromTokenContract: item.tokenContract,
        toTokenSymbol: candidate.tx.tokenSymbol,
        toTokenContract: candidate.tx.tokenContract,
        transactionAmount: amountPayload.value,
        transactionAmountFormatted: amountPayload.formatted,
        similarityPercent: candidate.similarity,
        delayMinutes: Math.max(0, Math.round(candidate.delayMs / 60000)),
        confidence: Math.min(45, traceConfidence({
          similarity: candidate.similarity,
          delayMs: candidate.delayMs,
          incomingCount: incoming.length,
          outgoingCount: outgoing.length + otherStablecoinCandidates.length,
          alternatives: Math.max(0, otherStablecoinCandidates.length - 1),
        })),
        destinationEntity: traceEntityForAddress(entityLabels, candidate.tx.to, "TRX"),
        status: "possible_asset_change",
        explanation:
          "После поступления одного стейблкоина найден близкий по сумме исходящий перевод другого стейблкоина. Это кандидат смены актива, а не подтверждённый обмен без разбора смарт-контракта.",
      });
    }

    if (!outgoing.length) {
      addEndpoint({
        item,
        address: item.address,
        status: "no_outgoing_in_window",
        note: `В течение ${safeHopWindowHours} ч. исходящих переводов этого токена не найдено.`,
      });
      continue;
    }

    const ranked = outgoing.map((tx) => ({
      tx,
      raw: toRawAmount(tx.rawValue),
      similarity: amountSimilarityPercent(item.amountRaw, toRawAmount(tx.rawValue)),
      delayMs: Number(tx.timestamp || 0) - item.receivedAt,
    }));
    const strongMatches = ranked
      .filter((candidate) => candidate.similarity >= 90 && candidate.delayMs <= 6 * 60 * 60 * 1000)
      .sort((a, b) => b.similarity - a.similarity || a.delayMs - b.delayMs);
    const orderedCandidates = strongMatches.length
      ? [...strongMatches, ...ranked.filter((candidate) => !strongMatches.includes(candidate))]
      : ranked;
    const comparison = {
      id: `comparison-${++comparisonSequence}`,
      hop: item.hop + 1,
      sourceAddress: item.address,
      incomingTransactionHash: item.lastTransactionHash,
      receivedAt: new Date(item.receivedAt).toISOString(),
      receivedAmount: traceAmountPayload(item.amountRaw, item.tokenDecimals).value,
      receivedAmountFormatted: traceAmountPayload(item.amountRaw, item.tokenDecimals).formatted,
      tokenSymbol: item.tokenSymbol,
      totalCandidates: orderedCandidates.length,
      displayedCandidates: Math.min(20, orderedCandidates.length),
      providerTruncated: nextWindow.truncated,
      activity: {
        incomingTransfersInWindow: incoming.length,
        outgoingTransfersInWindow: outgoing.length,
        strongMatches: strongMatches.length,
        commingled: incoming.length > 0 || outgoing.length > 5,
      },
      candidates: orderedCandidates.slice(0, 20).map((candidate, index) => {
        const candidateConfidence = traceConfidence({
          similarity: candidate.similarity,
          delayMs: candidate.delayMs,
          incomingCount: incoming.length,
          outgoingCount: outgoing.length,
          alternatives: Math.max(0, strongMatches.length - 1),
        });
        const candidateAmount = traceAmountPayload(candidate.raw, item.tokenDecimals);

        return {
          rank: index + 1,
          selected: false,
          transactionHash: traceBaseHash(candidate.tx),
          explorerUrl: candidate.tx.explorerUrl,
          destinationAddress: candidate.tx.to,
          destinationEntity: traceEntityForAddress(entityLabels, candidate.tx.to, "TRX"),
          timestamp: new Date(Number(candidate.tx.timestamp || 0)).toISOString(),
          transactionAmount: candidateAmount.value,
          transactionAmountFormatted: candidateAmount.formatted,
          tokenSymbol: item.tokenSymbol,
          similarityPercent: candidate.similarity,
          delayMinutes: Math.max(0, Math.round(candidate.delayMs / 60000)),
          confidence: candidateConfidence,
          strongMatch: candidate.similarity >= 90 && candidate.delayMs <= 6 * 60 * 60 * 1000,
          selectionReason:
            candidate.similarity >= 99.99
              ? "Exact amount match"
              : candidate.similarity >= 90
                ? "Close amount match"
                : "Chronological candidate",
        };
      }),
    };
    comparisons.push(comparison);
    let remaining = item.amountRaw;
    let usedBranches = 0;

    for (const candidate of orderedCandidates) {
      if (remaining <= 0n || usedBranches >= safeMaxBranches) {
        break;
      }

      if (candidate.raw <= 0n) {
        continue;
      }

      const attributedRaw = candidate.raw < remaining ? candidate.raw : remaining;
      const confidence = traceConfidence({
        similarity: candidate.similarity,
        delayMs: candidate.delayMs,
        incomingCount: incoming.length,
        outgoingCount: outgoing.length,
        alternatives: Math.max(0, strongMatches.length - 1),
      });
      const pathConfidence = Math.min(item.pathConfidence, confidence);
      const transactionAmount = traceAmountPayload(candidate.raw, item.tokenDecimals);
      const attributedAmount = traceAmountPayload(attributedRaw, item.tokenDecimals);
      const destinationEntity = traceEntityForAddress(entityLabels, candidate.tx.to, "TRX");
      const nextHop = item.hop + 1;
      const step = {
        id: `step-${++stepSequence}`,
        parentStepId: item.parentStepId,
        pathId: item.pathId,
        hop: nextHop,
        relation: "probable_allocation",
        confidence,
        sourceAddress: candidate.tx.from,
        destinationAddress: candidate.tx.to,
        originRecipientAddress: item.originRecipientAddress,
        originSeedTransactionHash: item.originSeedTransactionHash,
        transactionHash: traceBaseHash(candidate.tx),
        explorerUrl: candidate.tx.explorerUrl,
        timestamp: new Date(Number(candidate.tx.timestamp || 0)).toISOString(),
        tokenSymbol: item.tokenSymbol,
        tokenContract: item.tokenContract,
        transactionAmount: transactionAmount.value,
        transactionAmountFormatted: transactionAmount.formatted,
        transactionAmountRaw: transactionAmount.raw,
        attributedAmount: attributedAmount.value,
        attributedAmountFormatted: attributedAmount.formatted,
        attributedAmountRaw: attributedAmount.raw,
        destinationEntity,
        activity: {
          incomingTransfersInWindow: incoming.length,
          outgoingTransfersInWindow: outgoing.length,
          alternativeStrongMatches: Math.max(0, strongMatches.length - 1),
          commingled: incoming.length > 0 || outgoing.length > 5,
        },
        similarityPercent: candidate.similarity,
        delayMinutes: Math.max(0, Math.round(candidate.delayMs / 60000)),
        reason:
          "Сам перевод подтверждён блокчейном, но отнесение к ранее поступившим средствам является аналитической моделью по времени и сумме.",
      };
      const comparisonCandidate = comparison.candidates.find(
        (entry) => entry.transactionHash === traceBaseHash(candidate.tx) && entry.destinationAddress === candidate.tx.to
      );

      if (comparisonCandidate) {
        comparisonCandidate.selected = true;
        comparisonCandidate.attributedAmount = attributedAmount.value;
        comparisonCandidate.attributedAmountFormatted = attributedAmount.formatted;
      }
      steps.push(step);
      usedBranches += 1;
      remaining -= attributedRaw;
      const nextItem = {
        address: candidate.tx.to,
        originRecipientAddress: item.originRecipientAddress,
        originSeedTransactionHash: item.originSeedTransactionHash,
        amountRaw: attributedRaw,
        tokenDecimals: item.tokenDecimals,
        tokenSymbol: item.tokenSymbol,
        tokenContract: item.tokenContract,
        hop: nextHop,
        receivedAt: Number(candidate.tx.timestamp || 0),
        lastTransactionHash: traceBaseHash(candidate.tx),
        parentStepId: step.id,
        pathId: item.pathId,
        pathAddresses: [...item.pathAddresses, candidate.tx.to],
        pathStepIds: [...item.pathStepIds, step.id],
        pathConfidence,
      };

      if (item.pathAddresses.includes(candidate.tx.to)) {
        addEndpoint({ item: nextItem, address: candidate.tx.to, status: "cycle", note: "Обнаружен возврат на уже пройденный адрес." });
      } else if (destinationEntity) {
        addEndpoint({
          item: nextItem,
          address: candidate.tx.to,
          status: "known_entity",
          entity: destinationEntity,
          note: "Адрес совпал с записью в локальной базе организаций/рисков.",
        });
      } else if (nextHop >= safeDepth) {
        addEndpoint({
          item: nextItem,
          address: candidate.tx.to,
          status: "depth_limit",
          note: "Это конечный адрес только в пределах выбранной глубины проверки.",
        });
      } else {
        queue.push(nextItem);
      }
    }

    if (remaining > 0n) {
      addEndpoint({
        item: { ...item, amountRaw: remaining },
        address: item.address,
        status: usedBranches >= safeMaxBranches ? "branch_limit" : "unallocated",
        note:
          usedBranches >= safeMaxBranches
            ? "Часть суммы не распределена из-за ограничения количества веток."
            : "Не удалось сопоставить всю поступившую сумму с исходящими переводами.",
      });
    }
  }

  for (const item of queue) {
    addEndpoint({
      item,
      address: item.address,
      status: "scan_limit",
      note: "Проверка остановлена по техническому лимиту числа адресов.",
    });
  }

  if (queue.length) {
    warnings.push(`Достигнут технический предел ${maxTraceNodes} проверенных узлов. Оставшиеся ${queue.length} веток отмечены как конечные в пределах этой проверки.`);
  }

  if (allSeedCount > seeds.length) {
    warnings.push(`Найдено ${allSeedCount} исходящих переводов, прослежены первые ${seeds.length}. Уточните период, сумму или хеш.`);
  }
  if (providerTruncated) {
    warnings.push("Провайдер сообщил о дополнительной истории. Для полноты сузьте период и повторите проверку.");
  }

  const seedTotalRaw = seeds.reduce((sum, tx) => sum + toRawAmount(tx.rawValue), 0n);
  const terminalTotalRaw = endpoints.reduce((sum, endpoint) => sum + toRawAmount(endpoint.amountRaw), 0n);
  const identifiedTotalRaw = endpoints
    .filter((endpoint) => endpoint.entity)
    .reduce((sum, endpoint) => sum + toRawAmount(endpoint.amountRaw), 0n);
  const primaryDecimals = Number(seeds[0]?.tokenDecimals ?? 6);
  const terminalBuckets = new Map();
  const terminalStatusPriority = {
    known_entity: 8,
    no_outgoing_in_window: 7,
    depth_limit: 6,
    time_limit: 5,
    cycle: 4,
    scan_limit: 3,
    branch_limit: 2,
    unallocated: 1,
  };

  for (const endpoint of endpoints) {
    const key = String(endpoint.address || "").toLowerCase();
    let bucket = terminalBuckets.get(key);

    if (!bucket) {
      bucket = {
        address: endpoint.address,
        amountRaw: 0n,
        tokenSymbol: endpoint.tokenSymbol,
        statuses: new Set(),
        entity: endpoint.entity || null,
        minHop: Number(endpoint.hop || 0),
        maxHop: Number(endpoint.hop || 0),
        confidence: Number(endpoint.confidence ?? 100),
        paths: new Map(),
        originBranches: new Set(),
        transactionHashes: new Set(),
      };
      terminalBuckets.set(key, bucket);
    }

    bucket.amountRaw += toRawAmount(endpoint.amountRaw);
    bucket.statuses.add(endpoint.status);
    bucket.entity = bucket.entity || endpoint.entity || null;
    bucket.minHop = Math.min(bucket.minHop, Number(endpoint.hop || 0));
    bucket.maxHop = Math.max(bucket.maxHop, Number(endpoint.hop || 0));
    bucket.confidence = Math.min(bucket.confidence, Number(endpoint.confidence ?? 100));
    if (endpoint.originRecipientAddress) bucket.originBranches.add(endpoint.originRecipientAddress);
    if (endpoint.lastTransactionHash) bucket.transactionHashes.add(endpoint.lastTransactionHash);
    const pathKey = (endpoint.pathStepIds || []).join(">");
    if (!bucket.paths.has(pathKey)) {
      bucket.paths.set(pathKey, {
        stepIds: endpoint.pathStepIds || [],
        addresses: endpoint.pathAddresses || [],
      });
    }
  }

  const terminalAddresses = [...terminalBuckets.values()]
    .map((bucket) => {
      const status = [...bucket.statuses].sort(
        (a, b) => Number(terminalStatusPriority[b] || 0) - Number(terminalStatusPriority[a] || 0)
      )[0] || "unknown";
      const amountPayload = traceAmountPayload(bucket.amountRaw, primaryDecimals);
      const exitType = bucket.entity ? traceExitType(bucket.entity) : "";
      return {
        address: bucket.address,
        status,
        statuses: [...bucket.statuses],
        minHop: bucket.minHop,
        maxHop: bucket.maxHop,
        amount: amountPayload.value,
        amountFormatted: amountPayload.formatted,
        amountRaw: amountPayload.raw,
        tokenSymbol: bucket.tokenSymbol || normalizedSymbol,
        confidence: bucket.confidence,
        pathCount: bucket.paths.size,
        originBranchCount: bucket.originBranches.size,
        originBranches: [...bucket.originBranches],
        transactionHashes: [...bucket.transactionHashes],
        pathExamples: [...bucket.paths.values()].slice(0, 5),
        entity: bucket.entity,
        exitType,
        isExchange: exitType === "exchange",
      };
    })
    .sort((a, b) => Number(b.isExchange) - Number(a.isExchange) || b.amount - a.amount || a.address.localeCompare(b.address));
  const seedTotal = traceAmountPayload(seedTotalRaw, primaryDecimals);
  const terminalTotal = traceAmountPayload(terminalTotalRaw, primaryDecimals);
  const identifiedTotal = traceAmountPayload(identifiedTotalRaw, primaryDecimals);
  const convergenceBuckets = new Map();

  for (const step of steps) {
    if (Number(step.hop || 0) < 2 || !step.originRecipientAddress || !step.sourceAddress || !step.destinationAddress) {
      continue;
    }

    const destinationKey = String(step.destinationAddress).toLowerCase();
    const tokenKey = String(step.tokenContract || step.tokenSymbol || normalizedSymbol).toLowerCase();
    const bucketKey = `${tokenKey}:${destinationKey}`;
    const transactionKey = `${String(step.transactionHash || "").toLowerCase()}:${String(step.sourceAddress).toLowerCase()}:${destinationKey}`;
    let bucket = convergenceBuckets.get(bucketKey);

    if (!bucket) {
      bucket = {
        address: step.destinationAddress,
        tokenSymbol: step.tokenSymbol,
        tokenContract: step.tokenContract,
        branches: new Set(),
        sources: new Set(),
        transactions: new Map(),
      };
      convergenceBuckets.set(bucketKey, bucket);
    }

    bucket.branches.add(step.originRecipientAddress);
    bucket.sources.add(step.sourceAddress);

    if (!bucket.transactions.has(transactionKey)) {
      bucket.transactions.set(transactionKey, step);
    }
  }

  const convergences = [...convergenceBuckets.values()]
    .filter((bucket) => bucket.branches.size >= 2 && bucket.sources.size >= 2)
    .map((bucket, index) => {
      const evidenceSteps = [...bucket.transactions.values()].sort(
        (a, b) => Number(Date.parse(a.timestamp) || 0) - Number(Date.parse(b.timestamp) || 0)
      );
      const attributedRaw = evidenceSteps.reduce(
        (sum, step) => sum + toRawAmount(step.attributedAmountRaw),
        0n
      );
      const amountPayload = traceAmountPayload(attributedRaw, primaryDecimals);
      const coverageBasisPoints = seedTotalRaw > 0n
        ? (attributedRaw * 10000n) / seedTotalRaw
        : 0n;
      const coveragePercent = Math.min(999.99, Number(coverageBasisPoints) / 100);
      const confidence = evidenceSteps.length
        ? Math.min(...evidenceSteps.map((step) => Number(step.confidence || 0)))
        : 0;
      const entity = traceEntityForAddress(entityLabels, bucket.address, "TRX");

      return {
        id: `convergence-${index + 1}`,
        address: bucket.address,
        tokenSymbol: bucket.tokenSymbol,
        tokenContract: bucket.tokenContract,
        hop: Math.min(...evidenceSteps.map((step) => Number(step.hop || 0))),
        branchCount: bucket.branches.size,
        sourceCount: bucket.sources.size,
        branchAddresses: [...bucket.branches],
        sourceAddresses: [...bucket.sources],
        evidenceCount: evidenceSteps.length,
        attributedAmount: amountPayload.value,
        attributedAmountFormatted: amountPayload.formatted,
        attributedAmountRaw: amountPayload.raw,
        seedCoveragePercent: coveragePercent,
        confidence,
        entity,
        firstSeenAt: evidenceSteps[0]?.timestamp || null,
        lastSeenAt: evidenceSteps.at(-1)?.timestamp || null,
        interpretation: "possible_consolidation",
        explanation:
          "Несколько ранее разделённых веток перевели актив на один адрес. Транзакции подтверждены блокчейном; связь с исходными средствами после первого перехода остаётся аналитической оценкой.",
        transactions: evidenceSteps.map((step) => ({
          transactionHash: step.transactionHash,
          explorerUrl: step.explorerUrl,
          timestamp: step.timestamp,
          sourceAddress: step.sourceAddress,
          destinationAddress: step.destinationAddress,
          originRecipientAddress: step.originRecipientAddress,
          transactionAmount: step.transactionAmount,
          transactionAmountFormatted: step.transactionAmountFormatted,
          attributedAmount: step.attributedAmount,
          attributedAmountFormatted: step.attributedAmountFormatted,
          tokenSymbol: step.tokenSymbol,
          confidence: step.confidence,
        })),
      };
    })
    .sort(
      (a, b) => b.branchCount - a.branchCount
        || b.seedCoveragePercent - a.seedCoveragePercent
        || b.confidence - a.confidence
    );
  const exitBuckets = new Map();

  for (const step of steps) {
    if (!step.destinationEntity) continue;
    const addressKey = String(step.destinationAddress || "").toLowerCase();
    const exitType = traceExitType(step.destinationEntity);
    let bucket = exitBuckets.get(addressKey);

    if (!bucket) {
      bucket = {
        address: step.destinationAddress,
        exitType,
        entity: step.destinationEntity,
        transactions: new Map(),
      };
      exitBuckets.set(addressKey, bucket);
    }

    const transactionKey = `${String(step.transactionHash || "").toLowerCase()}:${String(step.sourceAddress || "").toLowerCase()}`;
    if (!bucket.transactions.has(transactionKey)) {
      bucket.transactions.set(transactionKey, step);
    }
  }

  const exitPoints = [...exitBuckets.values()]
    .map((bucket, index) => {
      const evidenceSteps = [...bucket.transactions.values()].sort(
        (a, b) => Number(Date.parse(a.timestamp) || 0) - Number(Date.parse(b.timestamp) || 0)
      );
      const attributedRaw = evidenceSteps.reduce(
        (sum, step) => sum + toRawAmount(step.attributedAmountRaw),
        0n
      );
      const amountPayload = traceAmountPayload(attributedRaw, primaryDecimals);
      const routeConfidence = evidenceSteps.length
        ? Math.min(...evidenceSteps.map((step) => Number(step.confidence || 0)))
        : 0;
      const labelConfidence = Number(bucket.entity?.confidence || 0);

      return {
        id: `exit-point-${index + 1}`,
        address: bucket.address,
        exitType: bucket.exitType,
        entity: bucket.entity,
        hop: Math.min(...evidenceSteps.map((step) => Number(step.hop || 0))),
        transactionCount: evidenceSteps.length,
        attributedAmount: amountPayload.value,
        attributedAmountFormatted: amountPayload.formatted,
        attributedAmountRaw: amountPayload.raw,
        tokenSymbol: evidenceSteps[0]?.tokenSymbol || normalizedSymbol,
        routeConfidence,
        labelConfidence,
        requestRecommended: ["exchange", "bridge", "payment_service", "gambling", "known_entity"].includes(bucket.exitType),
        evidenceStatement:
          "Перевод на этот адрес подтверждён блокчейном. Тип организации взят из подключённой базы меток и должен подтверждаться источником метки или ответом организации.",
        transactions: evidenceSteps.map((step) => ({
          transactionHash: step.transactionHash,
          explorerUrl: step.explorerUrl,
          timestamp: step.timestamp,
          sourceAddress: step.sourceAddress,
          destinationAddress: step.destinationAddress,
          transactionAmount: step.transactionAmount,
          transactionAmountFormatted: step.transactionAmountFormatted,
          attributedAmount: step.attributedAmount,
          attributedAmountFormatted: step.attributedAmountFormatted,
          tokenSymbol: step.tokenSymbol,
          confidence: step.confidence,
        })),
      };
    })
    .sort((a, b) => Number(b.requestRecommended) - Number(a.requestRecommended) || b.attributedAmount - a.attributedAmount);
  const creditedTerminalRaw = terminalTotalRaw > seedTotalRaw ? seedTotalRaw : terminalTotalRaw;
  const untracedRaw = seedTotalRaw > creditedTerminalRaw ? seedTotalRaw - creditedTerminalRaw : 0n;
  const knownExitRaw = exitPoints.reduce(
    (sum, exitPoint) => sum + toRawAmount(exitPoint.attributedAmountRaw),
    0n
  );
  const tracedCoveragePercent = seedTotalRaw > 0n
    ? Number((creditedTerminalRaw * 10000n) / seedTotalRaw) / 100
    : 0;
  const identifiedCoveragePercent = seedTotalRaw > 0n
    ? Number(((identifiedTotalRaw > seedTotalRaw ? seedTotalRaw : identifiedTotalRaw) * 10000n) / seedTotalRaw) / 100
    : 0;
  const knownExitCoveragePercent = seedTotalRaw > 0n
    ? Number(((knownExitRaw > seedTotalRaw ? seedTotalRaw : knownExitRaw) * 10000n) / seedTotalRaw) / 100
    : 0;
  const untracedAmount = traceAmountPayload(untracedRaw, primaryDecimals);
  const onwardSteps = steps.filter((step) => step.hop > 1);
  const ambiguousSteps = onwardSteps.filter(
    (step) => step.confidence < 50 || Number(step.activity?.alternativeStrongMatches || 0) > 0
  );
  const minOnwardConfidence = onwardSteps.length
    ? Math.min(...onwardSteps.map((step) => Number(step.confidence || 0)))
    : null;

  if (ambiguousSteps.length) {
    const alternatives = Math.max(
      ...ambiguousSteps.map((step) => Number(step.activity?.alternativeStrongMatches || 0)),
      0
    );
    warnings.push(
      `Продолжение маршрута неоднозначно: минимальная уверенность ${minOnwardConfidence}%, альтернативных близких переводов до ${alternatives}. Это версия для дополнительной проверки, не доказательство единственного маршрута.`
    );
  }

  const baseConclusion = onwardSteps.length === 0
    ? "Прямые переводы подтверждены, но дальнейшее движение в заданном окне не установлено."
    : ambiguousSteps.length
      ? `Прямой перевод подтверждён. Дальше найдено вероятное продолжение до ${Math.max(...steps.map((step) => step.hop), 1)} переходов, но маршрут неоднозначен (минимальная уверенность ${minOnwardConfidence}%). Нельзя утверждать, что установлен единственный конечный получатель.`
      : `Прямые переводы подтверждены. Построен вероятный маршрут до ${Math.max(...steps.map((step) => step.hop), 1)} переходов; каждый следующий переход требует проверки с учётом смешивания средств.`;
  const strongestConvergence = convergences[0] || null;
  const convergenceConclusion = strongestConvergence
    ? `Обнаружено схождение ${strongestConvergence.branchCount} веток на адресе ${strongestConvergence.address}. К этому адресу отнесено ${strongestConvergence.attributedAmountFormatted} ${strongestConvergence.tokenSymbol} (${strongestConvergence.seedCoveragePercent.toFixed(2)}% исходной суммы), минимальная уверенность связей ${strongestConvergence.confidence}%. Это приоритетный адрес для дальнейшей проверки, но не доказательство личности владельца.`
    : "Адрес, на котором сходятся две или более прослеженные ветки, в выбранных пределах не найден.";
  const strongestExitPoint = exitPoints[0] || null;
  const exitConclusion = strongestExitPoint
    ? `Найдена отмеченная организация: ${strongestExitPoint.entity.name} (${strongestExitPoint.exitType}), адрес ${strongestExitPoint.address}, отнесено ${strongestExitPoint.attributedAmountFormatted} ${strongestExitPoint.tokenSymbol}. Метку нужно подтвердить её источником или официальным ответом организации.`
    : "Подтверждённая по подключённой базе точка выхода в пределах проверки не найдена.";
  const conclusion = `${convergenceConclusion} ${exitConclusion} ${baseConclusion}`;
  const facts = steps.slice(0, 60).map(
    (step) =>
      `${step.timestamp}: ${step.sourceAddress} перевёл ${step.transactionAmountFormatted} ${step.tokenSymbol} на ${step.destinationAddress}; tx ${step.transactionHash}.`
  );
  const hypotheses = onwardSteps.slice(0, 60).map(
    (step) =>
      `Вероятная связь hop ${step.hop}: к маршруту отнесено ${step.attributedAmountFormatted} ${step.tokenSymbol}, уверенность ${step.confidence}% (совпадение суммы ${step.similarityPercent.toFixed(1)}%, задержка ${step.delayMinutes} мин.).`
  );
  const limitations = [
    "Запись блокчейна доказывает перевод между адресами, но сама по себе не устанавливает личность владельца адреса.",
    "После первого перевода связь средств по следующим адресам вероятностная: на активном кошельке деньги могут смешиваться с другими поступлениями.",
    "Конечный адрес в отчёте означает последний адрес в пределах выбранных дат, глубины и окна, а не гарантированного окончательного получателя.",
    "Для процессуального вывода сведения нужно подтвердить выгрузкой блокчейна и ответами бирж/провайдеров по официальному запросу.",
    ...warnings,
  ];

  const report = {
    reportId: makeId("fund-trace"),
    generatedAt,
    status: "complete",
    rootAddress: address,
    networkKey: "TRX",
    query: {
      mode: "all_available_branches",
      tokenSymbol: normalizedSymbol,
      startAt: new Date(startTimestamp).toISOString(),
      endAt: new Date(endTimestamp).toISOString(),
      seedTxHash: normalizedHash,
      amount: String(amount || ""),
      depth: safeDepth,
      hopWindowHours: safeHopWindowHours,
      maxBranches: safeMaxBranches,
      maxTraceNodes,
    },
    summary: {
      seedTransfersFound: allSeedCount,
      seedTransfersTraced: seeds.length,
      directRecipients: new Set(seeds.map((tx) => tx.to)).size,
      tracedSteps: steps.length,
      probableOnwardSteps: onwardSteps.length,
      endpointCount: terminalAddresses.length,
      exchangeTerminalCount: terminalAddresses.filter((endpoint) => endpoint.isExchange).length,
      knownEntityEndpoints: endpoints.filter((endpoint) => endpoint.entity).length,
      comparisonGroups: comparisons.length,
      alternativeCandidateCount: comparisons.reduce(
        (sum, comparison) => sum + comparison.candidates.filter((candidate) => !candidate.selected).length,
        0
      ),
      convergenceCount: convergences.length,
      strongestConvergenceAddress: strongestConvergence?.address || null,
      strongestConvergenceBranchCount: strongestConvergence?.branchCount || 0,
      strongestConvergenceCoveragePercent: strongestConvergence?.seedCoveragePercent || 0,
      exitPointCount: exitPoints.length,
      strongestExitPointAddress: strongestExitPoint?.address || null,
      strongestExitPointType: strongestExitPoint?.exitType || null,
      assetTransitionCandidateCount: assetTransitions.length,
      minOnwardConfidence,
      maxHopReached: Math.max(...steps.map((step) => step.hop), 0),
      seedAmount: seedTotal.value,
      seedAmountFormatted: seedTotal.formatted,
      terminalAmount: terminalTotal.value,
      terminalAmountFormatted: terminalTotal.formatted,
      identifiedAmount: identifiedTotal.value,
      identifiedAmountFormatted: identifiedTotal.formatted,
      untracedAmount: untracedAmount.value,
      untracedAmountFormatted: untracedAmount.formatted,
      tracedCoveragePercent,
      identifiedCoveragePercent,
      knownExitCoveragePercent,
      tokenSymbol: seeds[0]?.tokenSymbol || normalizedSymbol,
      conclusion,
    },
    steps,
    endpoints,
    terminalAddresses,
    comparisons,
    convergences,
    exitPoints,
    assetTransitions,
    facts,
    hypotheses,
    limitations,
    methodology: {
      name: "Временная атрибуция с проверкой суммы",
      traversal:
        "Обход в ширину по всем доступным веткам: каждый получатель становится следующим проверяемым узлом; циклы, предел глубины и технический предел фиксируются отдельно.",
      directEvidence: "Hop 1 — фактический исходящий перевод исходного адреса.",
      onwardModel:
        "Hop 2–6 — вероятностное распределение: приоритет близкой суммы в течение 6 часов, затем ранние исходящие переводы в выбранном окне.",
      assetChangeModel:
        "Смена стейблкоина отмечается как кандидат, если после поступления найден близкий по сумме перевод другого поддерживаемого стейблкоина. Без разбора смарт-контракта это не является подтверждённым swap.",
      confidence:
        "Оценка снижается при большом числе переводов, посторонних поступлениях и нескольких одинаково подходящих вариантах.",
    },
    provider: rootWindow.provider,
    providerPagesLoaded,
    warnings,
  };
  const reportSha256 = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  report.evidenceManifest = {
    formatVersion: 1,
    generatedAt,
    reportSha256,
    hashScope: "JSON-представление отчёта без поля evidenceManifest",
    provider: report.provider,
    rootAddress: report.rootAddress,
    networkKey: report.networkKey,
    recordCounts: {
      steps: report.steps.length,
      endpoints: report.endpoints.length,
      terminalAddresses: report.terminalAddresses.length,
      comparisons: report.comparisons.length,
      convergences: report.convergences.length,
      exitPoints: report.exitPoints.length,
      assetTransitions: report.assetTransitions.length,
    },
    evidenceNotice:
      "Контрольная сумма позволяет проверить неизменность выгрузки. Для процессуального использования сохраните также первичные ответы провайдера и подтвердите метки организаций официальными источниками.",
  };

  return report;
}

function graphNodeKey(networkKey, address) {
  return `${networkKey || "UNKNOWN"}:${String(address || "").toLowerCase()}`;
}

function graphAmountScore(tx) {
  const amount = toRawAmount(tx?.rawValue);
  const decimals = Number(tx?.tokenDecimals ?? nativeDecimalsForNetwork(tx?.networkKey));
  const scale = 10n ** BigInt(Math.max(0, decimals));

  if (!scale) {
    return 0;
  }

  const whole = amount / scale;
  const fraction = amount % scale;

  if (!fraction) {
    return Number(whole);
  }

  const precision = Math.min(Math.max(0, decimals), 12);
  const fractionText = fraction
    .toString()
    .padStart(Math.max(0, decimals), "0")
    .slice(0, precision)
    .replace(/0+$/, "");

  return Number(`${whole}.${fractionText || "0"}`);
}

function graphValueScore(tx) {
  const usdValue = Number(tx?.usdValue);
  return Number.isFinite(usdValue) && usdValue > 0 ? usdValue : graphAmountScore(tx);
}

function isNativeGraphValueRelevant(tx) {
  const usdValue = Number(tx?.usdValue);

  if (Number.isFinite(usdValue) && usdValue > 0) {
    return usdValue >= 10;
  }

  if (tx?.networkKey === "TRX") {
    return graphAmountScore(tx) >= 10;
  }

  if (tx?.networkKey === "BTC") {
    return graphAmountScore(tx) >= 0.0001;
  }

  return graphAmountScore(tx) >= 0.01;
}

function isGraphRelevantTransaction(tx, entityLabels = []) {
  if (!tx?.from || !tx?.to || tx.isDust || tx.isSpamToken) {
    return false;
  }

  const from = String(tx.from).toLowerCase();
  const to = String(tx.to).toLowerCase();
  const tokenSymbol = String(tx.tokenSymbol || "").toUpperCase();
  const tokenType = String(tx.tokenType || "native").toLowerCase();
  const stablecoinSymbols = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USD1"]);
  const matchedLabels = entityLabels.filter((label) => {
    const labelAddress = String(label.address || "").toLowerCase();
    return labelAddress && (labelAddress === from || labelAddress === to);
  });
  const hasInvestigativeLabel = matchedLabels.some((label) =>
    ["mixer", "tornado", "privacy", "bridge", "exchange", "cex", "scam", "sanctions"].includes(normalizeEntityCategory(label.category))
  );

  if (hasInvestigativeLabel) {
    return true;
  }

  if (stablecoinSymbols.has(tokenSymbol)) {
    return true;
  }

  if (tokenType === "native") {
    return isNativeGraphValueRelevant(tx);
  }

  return false;
}

function graphInvestigationReasons(tx, entityLabels = []) {
  const reasons = [];
  const from = String(tx?.from || "").toLowerCase();
  const to = String(tx?.to || "").toLowerCase();
  const tokenSymbol = String(tx?.tokenSymbol || "").toUpperCase();
  const tokenType = String(tx?.tokenType || "native").toLowerCase();
  const stablecoinSymbols = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USD1"]);
  const matchedLabels = entityLabels.filter((label) => {
    const labelAddress = String(label.address || "").toLowerCase();
    return labelAddress && (labelAddress === from || labelAddress === to);
  });

  for (const label of matchedLabels) {
    const category = normalizeEntityCategory(label.category);

    if (["mixer", "tornado", "privacy", "bridge", "exchange", "cex", "scam", "sanctions"].includes(category)) {
      reasons.push({
        type: category,
        title: `${category} label`,
        description: `${label.name || label.address} matched local entity labels`,
      });
    }
  }

  if (stablecoinSymbols.has(tokenSymbol)) {
    reasons.push({
      type: "stablecoin",
      title: "Stablecoin transfer",
      description: `${tokenSymbol} transfer is useful for AML tracing`,
    });
  }

  if (tokenType === "native" && isNativeGraphValueRelevant(tx)) {
    reasons.push({
      type: "native_value",
      title: "Native value transfer",
      description: tx.usdValue ? `Native transfer is worth about $${tx.usdValue}` : "Native transfer passed graph amount threshold",
    });
  }

  return reasons.length ? reasons : [{ type: "investigation", title: "Investigation edge", description: "Selected by graph relevance rules" }];
}

function graphEdgeCategory(reasons = [], tx = {}) {
  const reasonTypes = new Set((reasons || []).map((reason) => reason.type));

  if (["mixer", "tornado", "privacy"].some((type) => reasonTypes.has(type))) {
    return "mixer";
  }
  if (reasonTypes.has("bridge")) {
    return "bridge";
  }
  if (reasonTypes.has("exchange") || reasonTypes.has("cex")) {
    return "exchange";
  }
  if (reasonTypes.has("scam") || reasonTypes.has("sanctions")) {
    return "service";
  }
  if (reasonTypes.has("stablecoin")) {
    return "stablecoin";
  }
  if (reasonTypes.has("native_value") || String(tx.tokenType || "native").toLowerCase() === "native") {
    return "native";
  }

  return "unknown";
}

function preferredGraphEdgeCategory(current, next) {
  const priority = {
    mixer: 6,
    exchange: 5,
    bridge: 4,
    service: 3,
    stablecoin: 2,
    native: 1,
    unknown: 0,
  };

  return (priority[next] || 0) > (priority[current] || 0) ? next : current || next || "unknown";
}

function selectGraphInvestigationTransactions(items, entityLabels, limit) {
  const relevant = (items || [])
    .filter((tx) => isGraphRelevantTransaction(tx, entityLabels))
    .sort((a, b) => {
      const labelDelta =
        Number(isGraphRelevantTransaction(b, entityLabels)) - Number(isGraphRelevantTransaction(a, entityLabels));

      if (labelDelta) return labelDelta;

      const stableDelta =
        Number(["USDT", "USDC", "DAI", "TUSD", "USDD"].includes(String(b.tokenSymbol || "").toUpperCase())) -
        Number(["USDT", "USDC", "DAI", "TUSD", "USDD"].includes(String(a.tokenSymbol || "").toUpperCase()));

      if (stableDelta) return stableDelta;

      return graphValueScore(b) - graphValueScore(a);
    });

  if (relevant.length >= Math.min(2, limit)) {
    return relevant.slice(0, limit);
  }

  const fallback = (items || [])
    .filter((tx) => tx.from && tx.to && !tx.isSpamToken)
    .sort((a, b) => {
      const amountDelta = graphValueScore(b) - graphValueScore(a);

      if (amountDelta) return amountDelta;

      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });

  return [
    ...relevant,
    ...fallback.filter((tx) => !relevant.some((item) => (item.txHash || item.hash) === (tx.txHash || tx.hash))),
  ].slice(0, limit);
}

async function getGraphTransactions({ address, networkKey, limit }) {
  const result = await getTransactionsWithCache({
    address,
    networkKey,
    page: 1,
    limit: Math.max(limit * 4, 24),
    fingerprint: "",
    includeDust: false,
  });

  return result.items?.length || result.providerRequired !== true
    ? result
    : {
        items: [],
        errors: [`Unsupported graph address: ${address}`],
      };
}

function canExpandGraphAddress(address, networkKey) {
  if (networkKey === "TRX") {
    return isTronAddress(address);
  }

  if (networkKey === "BTC") {
    return isBitcoinAddress(address);
  }

  return isEvmAddress(address);
}

function graphTransactionTimestamp(tx) {
  const numeric = Number(tx?.timestamp);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(tx?.timestamp || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function graphTransactionMatchesPeriod(tx, startAt, endAt) {
  const timestamp = graphTransactionTimestamp(tx);
  const startMs = startAt ? Date.parse(startAt) : 0;
  const endMs = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY;

  if (!timestamp) return !startAt && !endAt;
  return timestamp >= (Number.isFinite(startMs) ? startMs : 0) && timestamp <= (Number.isFinite(endMs) ? endMs : Number.POSITIVE_INFINITY);
}

function graphTransactionMatchesDirection(tx, currentAddress, flowDirection) {
  const normalizedAddress = String(currentAddress || "").toLowerCase();
  const from = String(tx?.from || "").toLowerCase();
  const to = String(tx?.to || "").toLowerCase();

  if (flowDirection === "outgoing") return from === normalizedAddress;
  if (flowDirection === "incoming") return to === normalizedAddress;
  return from === normalizedAddress || to === normalizedAddress;
}

async function buildWalletGraph({ address, networkKey, depth, maxNodes, perAddressLimit, startAt = "", endAt = "", flowDirection = "all" }) {
  const entityLabels = await readEntityLabels();
  const nodes = new Map();
  const edges = new Map();
  const queue = [{ address, networkKey, depth: 0 }];
  const visited = new Set();
  const errors = [];
  const providers = new Set();
  const scannedNetworks = new Set();
  let scannedAddresses = 0;
  let spamTokenExcludedCount = 0;

  while (queue.length && nodes.size < maxNodes) {
    const current = queue.shift();
    const currentNetwork = current.networkKey || networkKey;
    const currentKey = graphNodeKey(currentNetwork, current.address);

    if (visited.has(currentKey) || !canExpandGraphAddress(current.address, currentNetwork)) {
      continue;
    }

    visited.add(currentKey);
    scannedAddresses += 1;

    if (!nodes.has(currentKey)) {
      nodes.set(currentKey, {
        id: currentKey,
        address: current.address,
        networkKey: currentNetwork,
        networkName: currentNetwork,
        depth: current.depth,
        txCount: 0,
      });
    }

    let result;

    try {
      result = await getGraphTransactions({
        address: current.address,
        networkKey: currentNetwork,
        limit: perAddressLimit,
      });
    } catch (error) {
      errors.push(`${current.address}: ${error.message}`);
      continue;
    }

    spamTokenExcludedCount += (result.items || []).filter((tx) => tx.isSpamToken).length;
    const periodItems = (result.items || []).filter((tx) =>
      graphTransactionMatchesPeriod(tx, startAt, endAt) &&
      graphTransactionMatchesDirection(tx, current.address, flowDirection)
    );
    const items = selectGraphInvestigationTransactions(periodItems, entityLabels, perAddressLimit);
    if (result.provider) {
      providers.add(result.provider);
    }
    for (const networkName of result.scannedNetworks || []) {
      scannedNetworks.add(networkName);
    }
    const currentNode = nodes.get(currentKey);
    currentNode.txCount += items.length;
    currentNode.networkName = items[0]?.networkName || currentNode.networkName;

    for (const tx of items) {
      const txNetwork = tx.networkKey || currentNetwork;
      const from = tx.from || "";
      const to = tx.to || "";

      if (!from || !to) {
        continue;
      }

      const fromKey = graphNodeKey(txNetwork, from);
      const toKey = graphNodeKey(txNetwork, to);
      const fromDepth = from.toLowerCase() === current.address.toLowerCase() ? current.depth : current.depth + 1;
      const toDepth = to.toLowerCase() === current.address.toLowerCase() ? current.depth : current.depth + 1;

      if (!nodes.has(fromKey) && nodes.size < maxNodes) {
        nodes.set(fromKey, {
          id: fromKey,
          address: from,
          networkKey: txNetwork,
          networkName: tx.networkName || txNetwork,
          depth: Math.min(depth, fromDepth),
          txCount: 0,
        });
      }

      if (!nodes.has(toKey) && nodes.size < maxNodes) {
        nodes.set(toKey, {
          id: toKey,
          address: to,
          networkKey: txNetwork,
          networkName: tx.networkName || txNetwork,
          depth: Math.min(depth, toDepth),
          txCount: 0,
        });
      }

      const edgeToken = tx.tokenSymbol || (tx.tokenType === "native" ? tx.networkKey : "TOKEN");
      const edgeKey = `${txNetwork}:${fromKey}:${toKey}:${edgeToken}:${tx.tokenContract || ""}`;
      const existingEdge = edges.get(edgeKey);
      const txAmount = toRawAmount(tx.rawValue);
      const investigationReasons = graphInvestigationReasons(tx, entityLabels);
      const edgeCategory = graphEdgeCategory(investigationReasons, tx);

      if (existingEdge) {
        const totalRaw = toRawAmount(existingEdge.rawValue) + txAmount;
        const decimals = Number(existingEdge.tokenDecimals ?? tx.tokenDecimals ?? nativeDecimalsForNetwork(txNetwork));
        const symbol = existingEdge.tokenSymbol || tx.tokenSymbol || edgeToken;
        const totalUsdValue = [existingEdge.usdValue, tx.usdValue]
          .map(Number)
          .filter((value) => Number.isFinite(value))
          .reduce((sum, value) => sum + value, 0);

        edges.set(edgeKey, {
          ...existingEdge,
          hash: existingEdge.hash || tx.hash,
          txHashes: uniqueValues([...(existingEdge.txHashes || []), tx.txHash || tx.hash]),
          investigationReasons: [
            ...new Map(
              [...(existingEdge.investigationReasons || []), ...investigationReasons].map((reason) => [
                `${reason.type}:${reason.title}`,
                reason,
              ])
            ).values(),
          ],
          edgeCategory: preferredGraphEdgeCategory(existingEdge.edgeCategory, edgeCategory),
          rawValue: String(totalRaw),
          value: `${formatDecimalUnits(String(totalRaw), decimals)} ${symbol} · ${(existingEdge.txCount || 1) + 1} tx`,
          usdValue: totalUsdValue ? Number(totalUsdValue.toFixed(2)) : null,
          usdPrice: existingEdge.usdPrice ?? tx.usdPrice ?? null,
          priceProvider: existingEdge.priceProvider || tx.priceProvider || "",
          timestamp: Math.max(existingEdge.timestamp || 0, tx.timestamp || 0),
          txCount: (existingEdge.txCount || 1) + 1,
        });
      } else {
        edges.set(edgeKey, {
          id: edgeKey,
          hash: tx.txHash || tx.hash,
          txHashes: [tx.txHash || tx.hash],
          from: fromKey,
          to: toKey,
          fromAddress: from,
          toAddress: to,
          value: tx.value,
          rawValue: tx.rawValue,
          amount: tx.amount,
          usdPrice: tx.usdPrice ?? null,
          usdValue: tx.usdValue ?? null,
          priceProvider: tx.priceProvider || "",
          pricedAt: tx.pricedAt || "",
          tokenSymbol: tx.tokenSymbol || edgeToken,
          tokenType: tx.tokenType || "native",
          tokenDecimals: tx.tokenDecimals ?? nativeDecimalsForNetwork(txNetwork),
          investigationReasons,
          edgeCategory,
          timestamp: tx.timestamp,
          networkKey: txNetwork,
          networkName: tx.networkName || txNetwork,
          explorerUrl: tx.explorerUrl,
          provider: tx.provider || result.provider || "",
          txCount: 1,
        });
      }

      const counterparties = [
        { address: from, nodeKey: fromKey },
        { address: to, nodeKey: toKey },
      ].filter((item) => item.address.toLowerCase() !== current.address.toLowerCase());

      for (const counterparty of counterparties) {
        if (
          current.depth + 1 <= depth &&
          nodes.size < maxNodes &&
          !visited.has(counterparty.nodeKey) &&
          canExpandGraphAddress(counterparty.address, txNetwork)
        ) {
          queue.push({
            address: counterparty.address,
            networkKey: txNetwork,
            depth: current.depth + 1,
          });
        }
      }
    }

    if (result.errors?.length) {
      errors.push(...result.errors.slice(0, 3));
    }
  }

  const graphNodes = [...nodes.values()].sort((a, b) => a.depth - b.depth);

  for (const node of graphNodes) {
    const manualLabel = entityLabels.find(
      (label) =>
        label.address?.toLowerCase() === node.address?.toLowerCase() &&
        (label.networkKey === node.networkKey || label.networkKey === "ALL" || label.networkKey === "UNKNOWN")
    );

    if (manualLabel) {
      node.manualLabel = manualLabel;
      node.nametag = manualLabel.name || node.nametag;
    }
  }

  const enrichableNodes = graphNodes
    .filter((node) => isEvmAddress(node.address) && !node.nametag)
    .sort((a, b) => (a.depth - b.depth) || ((b.txCount || 0) - (a.txCount || 0)))
    .slice(0, arkhamGraphEnrichmentLimit);

  for (const node of enrichableNodes) {
    const arkham = await getArkhamNodeNametag(node.address);

    if (arkham) {
      node.arkham = arkham;
      node.nametag = arkham.nametag;
    }
  }

  return {
    address,
    networkKey,
    depth,
    maxNodes,
    perAddressLimit,
    startAt: startAt || null,
    endAt: endAt || null,
    flowDirection,
    nodes: graphNodes,
    edges: [...edges.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
    stats: {
      scannedAddresses,
      nodeCount: nodes.size,
      edgeCount: edges.size,
      truncated: queue.length > 0 || nodes.size >= maxNodes,
      queuedRemainder: queue.length,
      arkhamEnrichedNodes: graphNodes.filter((node) => node.nametag).length,
      spamTokenExcludedCount,
    },
    provider: [...providers].join(" + ") || "Transaction providers",
    providers: [...providers],
    scannedNetworks: [...scannedNetworks],
    providerErrors: [...new Set(errors)].slice(0, 12),
    errors: [...new Set(errors)].slice(0, 12),
    dataQuality: {
      dataMode: [...providers].some((provider) => /cache/i.test(provider)) ? "cached" : "live",
      sourceProviders: [...providers],
      retrievedAt: new Date().toISOString(),
      completeness: errors.length ? "partial" : (queue.length > 0 || nodes.size >= maxNodes) ? "truncated" : "bounded_window",
      warnings: [
        ...(errors.length ? ["One or more providers returned an error; graph may be partial."] : []),
        ...((queue.length > 0 || nodes.size >= maxNodes) ? ["Graph stopped at configured node/depth limits."] : []),
      ],
    },
  };
}

function toRawAmount(value) {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function amountSimilarityPercent(a, b) {
  if (!a || !b || a <= 0n || b <= 0n) {
    return 0;
  }

  const min = a < b ? a : b;
  const max = a > b ? a : b;
  return Number((min * 10000n) / max) / 100;
}

function countTrailingZeros(value) {
  const text = String(value || "0").replace(/^-/, "");

  if (text === "0") {
    return Infinity;
  }

  let count = 0;

  for (let index = text.length - 1; index >= 0 && text[index] === "0"; index -= 1) {
    count += 1;
  }

  return count;
}

function isRoundAmount(value) {
  return countTrailingZeros(value) >= 6;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeEntityCategory(value) {
  return String(value || "entity").trim().toLowerCase() || "entity";
}

function isSanctionsEntityLabel(label) {
  const category = normalizeEntityCategory(label?.category);
  const source = String(label?.source || "").trim().toLowerCase();
  const notes = String(label?.notes || "").trim().toLowerCase();

  return category.includes("sanction") || source.startsWith("ofac-sls") || notes.includes("ofac");
}

function buildRouteKey(type, txHashes) {
  return `${type}:${txHashes.join(">")}`;
}

function buildRouteStep(tx, label = "") {
  return {
    hash: tx.hash,
    direction: tx.direction,
    address: tx.direction === "in" ? tx.from : tx.to,
    counterparty: tx.direction === "in" ? tx.to : tx.from,
    label,
    value: tx.value,
    timestamp: tx.timestamp,
    networkName: tx.networkName,
    networkKey: tx.networkKey,
  };
}


function analyzeTransactions(address, items, entityLabels = []) {
  const target = address.toLowerCase();
  const inputItems = withSpamTokenFlags(items);
  const sorted = inputItems
    .map((tx) => ({ ...tx }))
    .filter((tx) => tx.timestamp && !tx.isSpamToken)
    .sort((a, b) => a.timestamp - b.timestamp);
  const spamTokenCount = inputItems.filter((tx) => tx.isSpamToken).length;
  const byHash = new Map();
  const signals = [];
  const riskFactors = [];
  const suspiciousRoutes = [];
  const exitScores = new Map();
  const counterpartyStats = new Map();
  const entityHits = [];
  const labelsByAddress = new Map();
  const addressCategories = new Map();
  const routeKeys = new Set();
  const factorKeys = new Set();
  const oneHourMs = 60 * 60 * 1000;
  const sixHoursMs = 6 * oneHourMs;
  const dayMs = 24 * oneHourMs;
  const stablecoinSymbols = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USD1"]);

  for (const label of entityLabels.filter((item) => item.address)) {
    const key = label.address.toLowerCase();
    const category = normalizeEntityCategory(label.category);
    const labels = labelsByAddress.get(key) || [];
    labels.push({ ...label, category });
    labelsByAddress.set(key, labels);
    addressCategories.set(
      key,
      uniqueValues([...(addressCategories.get(key) || []), category])
    );
  }

  const mark = (hash, flag) => {
    if (!hash) {
      return;
    }

    const current = byHash.get(hash) || [];
    if (!current.includes(flag)) {
      byHash.set(hash, [...current, flag]);
    }
  };

  const addFactor = ({ type, title, points, confidence, description, txHashes = [] }) => {
    const key = `${type}:${txHashes.join("|")}`;
    if (factorKeys.has(key)) {
      return;
    }

    factorKeys.add(key);
    riskFactors.push({
      type,
      title,
      points,
      confidence,
      description,
      txHashes,
    });
  };

  const addRoute = ({ type, title, confidence, reason, txs }) => {
    const txHashes = txs.map((tx) => tx.hash);
    const key = buildRouteKey(type, txHashes);
    if (routeKeys.has(key) || txHashes.length < 2) {
      return;
    }

    routeKeys.add(key);
    suspiciousRoutes.push({
      type,
      title,
      confidence,
      reason,
      txHashes,
      steps: txs.map((tx) => buildRouteStep(tx, tx.flagLabel || "")),
    });
  };

  const categoriesFor = (value) => addressCategories.get(String(value || "").toLowerCase()) || [];

  const annotateTx = (tx) => {
    tx.fromLower = (tx.from || "").toLowerCase();
    tx.toLower = (tx.to || "").toLowerCase();
    tx.amount = toRawAmount(tx.rawValue);
    tx.isRound = isRoundAmount(tx.rawValue);
    tx.fromCategories = categoriesFor(tx.from);
    tx.toCategories = categoriesFor(tx.to);
    tx.categories = uniqueValues([...tx.fromCategories, ...tx.toCategories]);
    tx.isTokenTransfer = ["ERC20", "TRC20"].includes(tx.tokenType || "");
    tx.isStablecoin = stablecoinSymbols.has(String(tx.tokenSymbol || "").toUpperCase());
  };

  for (const tx of sorted) {
    annotateTx(tx);

    const counterparty = tx.fromLower === target ? tx.to : tx.from;
    const matchedLabels = [tx.fromLower, tx.toLower]
      .flatMap((addressKey) => labelsByAddress.get(addressKey) || [])
      .filter((label) => ["ALL", "UNKNOWN", tx.networkKey].includes(label.networkKey || "UNKNOWN"));

    for (const label of matchedLabels) {
      const flag = `known_${label.category || "entity"}`;
      mark(tx.hash, flag);
      entityHits.push({
        txHash: tx.hash,
        address: label.address,
        name: label.name || "Known entity",
        category: label.category || "entity",
        networkKey: label.networkKey || tx.networkKey,
        confidence: Number(label.confidence || 80),
      });

      if (["mixer", "tornado", "privacy"].includes(label.category)) {
        mark(tx.hash, "mixer_contact");
      }
      if (label.category === "bridge") {
        mark(tx.hash, "bridge_contact");
      }
      if (["exchange", "cex"].includes(label.category)) {
        mark(tx.hash, "exchange_contact");
      }
    }

    if (!counterparty) {
      continue;
    }

    const key = counterparty.toLowerCase();
    const stats = counterpartyStats.get(key) || {
      address: counterparty,
      inbound: 0,
      outbound: 0,
      total: 0,
      firstSeen: tx.timestamp,
      lastSeen: tx.timestamp,
    };

      stats.total += 1;
    stats.firstSeen = Math.min(stats.firstSeen, tx.timestamp);
    stats.lastSeen = Math.max(stats.lastSeen, tx.timestamp);

    if (tx.direction === "in") {
      stats.inbound += 1;
    }

    if (tx.direction === "out") {
      stats.outbound += 1;
    }

    counterpartyStats.set(key, stats);
  }

  const txCategories = (tx) => tx?.categories || uniqueValues([...(tx?.fromCategories || []), ...(tx?.toCategories || [])]);
  const hasCategory = (tx, categories) => txCategories(tx).some((category) => categories.includes(category));
  const serviceCategories = ["service", "miner", "validator", "miner-validator", "builder", "mev", "bot"];
  const hasServiceCategory = (categories) => (categories || []).some((category) => serviceCategories.includes(category));
  const targetIsService = hasServiceCategory(categoriesFor(target));
  const isExchangeTx = (tx) => hasCategory(tx, ["exchange", "cex"]);
  const isMixerLikeTx = (tx) => hasCategory(tx, ["mixer", "tornado", "privacy"]);
  const isBridgeTx = (tx) => hasCategory(tx, ["bridge"]);
  const targetIsKnownMixer = categoriesFor(target).some((category) => ["mixer", "tornado", "privacy"].includes(category));
  const txAssetKey = (tx) => `${tx.networkKey || "UNKNOWN"}:${tx.tokenContract || tx.tokenSymbol || tx.tokenType || "native"}`;
  const counterpartyForTx = (tx) => (tx.direction === "out" ? tx.toLower : tx.fromLower);
  const isFreshCounterparty = (tx) => {
    const key = counterpartyForTx(tx);
    const stats = counterpartyStats.get(key);
    return Boolean(key && stats && stats.total === 1);
  };
  const mixerHeuristicFindings = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const incoming = sorted[index];
    if (incoming.direction !== "in") {
      continue;
    }

    const followingOutputs = sorted
      .slice(index + 1)
      .filter((tx) => tx.direction === "out" && tx.timestamp - incoming.timestamp <= sixHoursMs);

    if (!followingOutputs.length) {
      continue;
    }

    const incomingAmount = incoming.amount;
    const outgoingSum = followingOutputs.reduce((sum, tx) => sum + tx.amount, 0n);
    const outgoingSimilar = followingOutputs.filter((tx) => amountSimilarityPercent(incomingAmount, tx.amount) >= 70);

    for (const outgoing of outgoingSimilar) {
      const delayMs = outgoing.timestamp - incoming.timestamp;
      const similarity = amountSimilarityPercent(incomingAmount, outgoing.amount);
      const score = Math.min(94, Math.round(45 + similarity / 2 + Math.max(0, 20 - delayMs / 180000)));
      const candidateKey = (outgoing.to || "").toLowerCase();
      const outgoingCategories = uniqueValues([...outgoing.fromCategories, ...outgoing.toCategories]);
      const serviceSuppressed = targetIsService && !isMixerLikeTx(incoming) && !isBridgeTx(incoming) && !isExchangeTx(outgoing);
      const strongRouteContext =
        isMixerLikeTx(incoming) ||
        isBridgeTx(incoming) ||
        isExchangeTx(outgoing) ||
        (incoming.isStablecoin && outgoing.isStablecoin) ||
        (outgoing.isRound && isFreshCounterparty(outgoing));
      const preciseFastMatch = delayMs <= oneHourMs && similarity >= 85;
      const shouldPromoteFastPair = !serviceSuppressed && (strongRouteContext || preciseFastMatch);

      if (shouldPromoteFastPair) {
        mark(incoming.hash, "fast_in");
        mark(outgoing.hash, "fast_out");
        mark(outgoing.hash, outgoing.isRound ? "round_amount" : "fast_exit");
      } else {
        mark(incoming.hash, "quick_match");
        mark(outgoing.hash, "quick_match");
      }

      if (candidateKey && shouldPromoteFastPair) {
        const previous = exitScores.get(candidateKey);
        const candidate = {
          address: outgoing.to,
          probability: Math.max(score, previous?.probability || 0),
          reason: `быстрый выход через ${Math.max(1, Math.round(delayMs / 60000))} мин, совпадение суммы ${similarity.toFixed(1)}%`,
          txHash: outgoing.hash,
          networkName: outgoing.networkName,
          networkKey: outgoing.networkKey,
        };
        exitScores.set(candidateKey, candidate);
      }

      if (shouldPromoteFastPair) {
        addRoute({
          type: "fast_exit",
          title: strongRouteContext ? "Контекстный быстрый выход" : "Быстрый транзит",
          confidence: score,
          reason: `Выход через ${Math.max(1, Math.round(delayMs / 60000))} мин после входа`,
          txs: [incoming, outgoing],
        });

        addFactor({
          type: "time_correlation",
          title: strongRouteContext ? "Контекстная временная связь" : "Слабая временная связь",
          points: strongRouteContext ? 8 : 4,
          confidence: strongRouteContext ? score : Math.min(72, score),
          description: strongRouteContext
            ? `Вход и выход разделены на ${Math.max(1, Math.round(delayMs / 60000))} мин вместе с дополнительным route-контекстом`
            : `Вход и выход разделены на ${Math.max(1, Math.round(delayMs / 60000))} мин; без mixer/service контекста это слабый сигнал`,
          txHashes: [incoming.hash, outgoing.hash],
        });

        addFactor({
          type: "amount_similarity",
          title: "Похожая сумма",
          points: strongRouteContext ? 8 : 4,
          confidence: strongRouteContext ? similarity : Math.min(72, similarity),
          description: `Сходство суммы ${similarity.toFixed(1)}%`,
          txHashes: [incoming.hash, outgoing.hash],
        });
      }

      if (outgoing.isRound) {
        mark(outgoing.hash, "round_amount");
        addFactor({
          type: "round_amount",
          title: "Round amount",
          points: 8,
          confidence: 72,
          description: "Сумма выглядит округленной",
          txHashes: [outgoing.hash],
        });
      }

      const addRouteFactor = ({ type, title, points, confidence, description }) => {
        mark(outgoing.hash, type);
        addFactor({
          type,
          title,
          points,
          confidence,
          description,
          txHashes: [outgoing.hash],
        });
      };

      if (outgoingCategories.includes("exchange") || outgoingCategories.includes("cex")) {
        mark(outgoing.hash, "exchange_deposit");
        addRouteFactor({
          type: "exchange_cashout",
          title: "Cash-out на биржу",
          points: 15,
          confidence: Math.min(95, score + 5),
          description: "Выход направлен на адрес биржи",
          txHashes: [outgoing.hash],
        });
      }
      if (outgoingCategories.includes("bridge")) {
        addRouteFactor({
          type: "bridge_hop",
          title: "Bridge hop",
          points: 12,
          confidence: Math.min(92, score + 4),
          description: "Выход проходит через bridge-адрес",
          txHashes: [outgoing.hash],
        });
      }

      if (incoming.isStablecoin && outgoing.isStablecoin) {
        mark(incoming.hash, "stablecoin_fast_in");
        mark(outgoing.hash, "stablecoin_fast_out");
        addFactor({
          type: "stablecoin_fast_exit",
          title: "Быстрый stablecoin exit",
          points: 16,
          confidence: Math.min(94, score + 2),
          description: `${incoming.tokenSymbol || "stablecoin"} вход и выход с близкой суммой в коротком окне`,
          txHashes: [incoming.hash, outgoing.hash],
        });
      }
    }

    const fanOutSimilar = followingOutputs.filter((tx) => amountSimilarityPercent(incomingAmount, tx.amount) >= 55);
    const fanOutSumRatio = incomingAmount > 0n ? Number((outgoingSum * 10000n) / incomingAmount) / 100 : 0;
    if (fanOutSimilar.length >= 3 && fanOutSumRatio >= 60 && fanOutSumRatio <= 140) {
      for (const tx of fanOutSimilar.slice(0, 6)) {
        mark(tx.hash, "fan_out");
      }

      addFactor({
        type: "fan_out",
        title: "Fan-out",
        points: 16,
        confidence: Math.min(95, 60 + fanOutSimilar.length * 6),
        description: `${fanOutSimilar.length} исходящих переводов после одного входа`,
        txHashes: [incoming.hash, ...fanOutSimilar.slice(0, 4).map((tx) => tx.hash)],
      });

      addRoute({
        type: "fan_out",
        title: "Дробление средств",
        confidence: Math.min(95, 60 + fanOutSimilar.length * 6),
        reason: `Один вход распределен на ${fanOutSimilar.length} выходов`,
        txs: [incoming, ...fanOutSimilar.slice(0, 4)],
      });
    }

    const incomingCategories = uniqueValues([...incoming.fromCategories, ...incoming.toCategories]);
    if (incomingCategories.includes("mixer") || incomingCategories.includes("tornado") || incomingCategories.includes("privacy") || incomingCategories.includes("bridge")) {
      const chainOutputs = followingOutputs.filter((tx) => tx.timestamp - incoming.timestamp <= dayMs);
      const chainExits = chainOutputs.filter((tx) => isExchangeTx(tx));
      const directMixerSource = isMixerLikeTx(incoming);

      if (chainExits.length) {
        const exitTx = chainExits[0];
        mark(exitTx.hash, directMixerSource ? "mixer_chain" : "bridge_chain");
        mark(exitTx.hash, "exchange_cashout");
        mark(exitTx.hash, "exchange_deanonymization");
        mark(incoming.hash, directMixerSource ? "mixer_source" : "bridge_contact");
        addFactor({
          type: directMixerSource ? "mixer_chain" : "bridge_chain",
          title: directMixerSource ? "Mixer -> exchange chain" : "Bridge -> exchange chain",
          points: directMixerSource ? 30 : 16,
          confidence: directMixerSource ? 92 : 78,
          description: directMixerSource
            ? "После прямого контакта с known mixer найден cash-out на exchange. Это подтвержденный mixer-context по локальной базе."
            : "После bridge-контакта найден cash-out на exchange. Это bridge-flow, не подтверждение миксера.",
          txHashes: [incoming.hash, exitTx.hash],
        });
        addRoute({
          type: directMixerSource ? "mixer_chain" : "bridge_chain",
          title: directMixerSource ? "Mixer -> Exchange deanonymization" : "Bridge -> Exchange cash-out",
          confidence: directMixerSource ? 92 : 78,
          reason: directMixerSource
            ? "Средства после known mixer уходят на биржу, где возможна KYC-деанонимизация"
            : "Средства после bridge уходят на биржу; это cross-chain/service path, не mixer evidence",
          txs: [incoming, exitTx],
        });
      }
    }
  }

  const outgoing = sorted.filter((tx) => tx.direction === "out" && tx.amount > 0n);

  for (const tx of outgoing.filter(isExchangeTx)) {
    mark(tx.hash, "exchange_deposit");

    const previousInputs = sorted.filter(
      (incoming) =>
        incoming.direction === "in" &&
        tx.timestamp > incoming.timestamp &&
        tx.timestamp - incoming.timestamp <= dayMs
    );
    const mixerInputs = previousInputs.filter((incoming) => isMixerLikeTx(incoming));
    const bridgeInputs = previousInputs.filter((incoming) => isBridgeTx(incoming));
    const similarInputs = previousInputs.filter((incoming) => amountSimilarityPercent(incoming.amount, tx.amount) >= 65);
    const mixerSimilar = mixerInputs.find((incoming) => amountSimilarityPercent(incoming.amount, tx.amount) >= 55) || mixerInputs[0];
    const bridgeSimilar = bridgeInputs.find((incoming) => amountSimilarityPercent(incoming.amount, tx.amount) >= 65);

    if (mixerSimilar) {
      const delayMinutes = Math.max(1, Math.round((tx.timestamp - mixerSimilar.timestamp) / 60000));
      const similarity = amountSimilarityPercent(mixerSimilar.amount, tx.amount);

      mark(mixerSimilar.hash, "mixer_source");
      mark(tx.hash, "mixer_to_exchange");
      mark(tx.hash, "exchange_deanonymization");
      mark(tx.hash, "exchange_cashout");
      addFactor({
        type: "exchange_deanonymization",
        title: "Биржа после mixer-flow",
        points: 32,
        confidence: Math.min(96, 72 + Math.round(similarity / 4)),
        description: `Выход на биржу через ${delayMinutes} мин после known mixer входа. Депозит на CEX может связать адрес с KYC аккаунтом`,
        txHashes: [mixerSimilar.hash, tx.hash],
      });
      addRoute({
        type: "mixer_to_exchange",
        title: "Mixer-flow -> CEX deposit",
        confidence: Math.min(96, 72 + Math.round(similarity / 4)),
        reason: `Known mixer вход и последующий депозит на биржу; сходство суммы ${similarity.toFixed(1)}%`,
        txs: [mixerSimilar, tx],
      });
    } else if (bridgeSimilar) {
      const delayMinutes = Math.max(1, Math.round((tx.timestamp - bridgeSimilar.timestamp) / 60000));
      const similarity = amountSimilarityPercent(bridgeSimilar.amount, tx.amount);

      mark(bridgeSimilar.hash, "bridge_contact");
      mark(tx.hash, "bridge_to_exchange");
      mark(tx.hash, "exchange_deanonymization");
      addFactor({
        type: "bridge_to_exchange",
        title: "Bridge -> CEX deposit",
        points: 16,
        confidence: Math.min(86, 60 + Math.round(similarity / 6)),
        description: `Выход на биржу через ${delayMinutes} мин после bridge входа. Это не mixer evidence, но может быть cash-out path.`,
        txHashes: [bridgeSimilar.hash, tx.hash],
      });
      addRoute({
        type: "bridge_to_exchange",
        title: "Bridge -> CEX deposit",
        confidence: Math.min(86, 60 + Math.round(similarity / 6)),
        reason: `Bridge вход и последующий депозит на биржу; сходство суммы ${similarity.toFixed(1)}%`,
        txs: [bridgeSimilar, tx],
      });
    } else if (similarInputs.length) {
      const closestInput = similarInputs.sort((a, b) => amountSimilarityPercent(b.amount, tx.amount) - amountSimilarityPercent(a.amount, tx.amount))[0];
      const delayMinutes = Math.max(1, Math.round((tx.timestamp - closestInput.timestamp) / 60000));
      const similarity = amountSimilarityPercent(closestInput.amount, tx.amount);

      mark(closestInput.hash, "exchange_funding_source");
      mark(tx.hash, "exchange_deanonymization");
      addFactor({
        type: "exchange_deanonymization",
        title: "Потенциальная деанонимизация через биржу",
        points: 18,
        confidence: Math.min(88, 58 + Math.round(similarity / 5)),
        description: `Депозит на биржу через ${delayMinutes} мин после входа со сходством суммы ${similarity.toFixed(1)}%. Биржа может связать адрес с KYC аккаунтом`,
        txHashes: [closestInput.hash, tx.hash],
      });
      addRoute({
        type: "exchange_deposit_trace",
        title: "Funding source -> CEX deposit",
        confidence: Math.min(88, 58 + Math.round(similarity / 5)),
        reason: "Входящий перевод быстро сопоставляется с последующим депозитом на биржу",
        txs: [closestInput, tx],
      });
    } else {
      addFactor({
        type: "exchange_deposit",
        title: "Депозит на биржу",
        points: 9,
        confidence: 70,
        description: "Исходящий перевод на биржу. Сам по себе это не illicit-сигнал, но полезен для deanonymization path",
        txHashes: [tx.hash],
      });
    }
  }

  for (let index = 0; index < outgoing.length; index += 1) {
    const window = outgoing.filter((tx) => tx.timestamp >= outgoing[index].timestamp && tx.timestamp - outgoing[index].timestamp <= sixHoursMs);

    if (window.length < 3) {
      continue;
    }

    const base = outgoing[index].amount;
    const similar = window.filter((tx) => amountSimilarityPercent(base, tx.amount) >= 85);

    if (similar.length >= 3) {
      for (const tx of similar) {
        mark(tx.hash, "split");
      }

      addFactor({
        type: "fan_out",
        title: "Fan-out / splitting",
        points: 18,
        confidence: Math.min(95, 55 + similar.length * 8),
        description: `${similar.length} исходящих переводов с близкими суммами в окне до 6 часов`,
        txHashes: similar.slice(0, 4).map((tx) => tx.hash),
      });

      addRoute({
        type: "split_pattern",
        title: "Дробление в окне",
        confidence: Math.min(95, 55 + similar.length * 8),
        reason: `${similar.length} исходящих переводов с близкими суммами`,
        txs: similar.slice(0, 4),
      });
      break;
    }
  }

  for (let index = 0; index < outgoing.length; index += 1) {
    const window = outgoing.filter((tx) => tx.timestamp >= outgoing[index].timestamp && tx.timestamp - outgoing[index].timestamp <= sixHoursMs);

    if (window.length < 4) {
      continue;
    }

    const base = outgoing[index].amount;
    const equalized = window.filter((tx) => amountSimilarityPercent(base, tx.amount) >= 92);
    const uniqueRecipients = new Set(equalized.map((tx) => tx.toLower).filter(Boolean));
    const roundShare = equalized.length
      ? equalized.filter((tx) => tx.isRound).length / equalized.length
      : 0;

    if (!targetIsService && equalized.length >= 4 && uniqueRecipients.size >= 4 && roundShare >= 0.5) {
      const flag = targetIsKnownMixer ? "mixer_equalized_withdrawal" : "equalized_withdrawal_cluster";
      for (const tx of equalized.slice(0, 12)) {
        mark(tx.hash, flag);
        if (targetIsKnownMixer) {
          mark(tx.hash, "possible_mixer_flow");
        }
      }

      addFactor({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer equalized withdrawals" : "Equalized withdrawal cluster",
        points: targetIsKnownMixer ? 26 : 12,
        confidence: targetIsKnownMixer ? Math.min(96, 68 + equalized.length * 4) : Math.min(76, 52 + equalized.length * 3),
        description: targetIsKnownMixer
          ? `${equalized.length} исходящих переводов с почти одинаковой округленной суммой на разные адреса от known mixer адреса`
          : `${equalized.length} исходящих переводов с почти одинаковой округленной суммой. Без known mixer label это структурный паттерн, не подтверждение миксера.`,
        txHashes: equalized.slice(0, 5).map((tx) => tx.hash),
      });
      addRoute({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer equalized withdrawals" : "Equalized withdrawal cluster",
        confidence: targetIsKnownMixer ? Math.min(96, 68 + equalized.length * 4) : Math.min(76, 52 + equalized.length * 3),
        reason: targetIsKnownMixer
          ? "Known mixer адрес распределяет одинаковые суммы на разные адреса"
          : "Одинаковые суммы на разные адреса в коротком окне; показано как структурный паттерн без mixer-утверждения",
        txs: equalized.slice(0, 5),
      });
      break;
    }
  }

  for (let index = 0; index < outgoing.length; index += 1) {
    const baseTx = outgoing[index];
    const window = outgoing.filter((tx) =>
      tx.timestamp >= baseTx.timestamp &&
      tx.timestamp - baseTx.timestamp <= sixHoursMs &&
      txAssetKey(tx) === txAssetKey(baseTx)
    );

    if (window.length < 3 || baseTx.amount <= 0n) {
      continue;
    }

    const denominationCluster = window.filter((tx) => amountSimilarityPercent(baseTx.amount, tx.amount) >= 97);
    const uniqueRecipients = new Set(denominationCluster.map((tx) => tx.toLower).filter(Boolean));
    const freshRecipients = denominationCluster.filter(isFreshCounterparty).length;
    const freshShare = denominationCluster.length ? freshRecipients / denominationCluster.length : 0;
    const serviceShare = denominationCluster.length
      ? denominationCluster.filter((tx) => isExchangeTx(tx) || isBridgeTx(tx) || isMixerLikeTx(tx)).length / denominationCluster.length
      : 0;

    if (!targetIsService && denominationCluster.length >= 3 && uniqueRecipients.size >= 3 && serviceShare < 0.5) {
      const flag = targetIsKnownMixer ? "mixer_denomination_cluster" : "structured_denomination_cluster";
      const confidence = targetIsKnownMixer
        ? Math.min(98, 66 + denominationCluster.length * 5 + Math.round(freshShare * 14))
        : Math.min(78, 50 + denominationCluster.length * 4 + Math.round(freshShare * 8));
      const sample = denominationCluster.slice(0, 8);

      for (const tx of sample) {
        mark(tx.hash, flag);
        if (targetIsKnownMixer) {
          mark(tx.hash, "possible_mixer_flow");
        }

        const candidateKey = (tx.to || "").toLowerCase();
        if (candidateKey && targetIsKnownMixer) {
          const previous = exitScores.get(candidateKey);
          exitScores.set(candidateKey, {
            address: tx.to,
            probability: Math.max(confidence, previous?.probability || 0),
            reason: `denomination cluster: ${denominationCluster.length} похожих выходов, fresh wallets ${Math.round(freshShare * 100)}%`,
            txHash: tx.hash,
            networkName: tx.networkName,
            networkKey: tx.networkKey,
          });
        }
      }

      if (targetIsKnownMixer) {
        mixerHeuristicFindings.push({
          type: "denomination_cluster",
          confidence,
          count: denominationCluster.length,
        });
      }

      addFactor({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer denomination cluster" : "Structured denomination cluster",
        points: targetIsKnownMixer ? Math.min(34, 18 + denominationCluster.length * 3) : Math.min(18, 8 + denominationCluster.length * 2),
        confidence,
        description: targetIsKnownMixer
          ? `${denominationCluster.length} исходящих переводов одного asset с совпадением суммы >=97% на ${uniqueRecipients.size} разных адресов; fresh wallets ${Math.round(freshShare * 100)}%`
          : `${denominationCluster.length} переводов одного asset с совпадением суммы >=97%. Без known mixer label это не считается mixer-hit.`,
        txHashes: sample.slice(0, 5).map((tx) => tx.hash),
      });

      addRoute({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer denomination cluster" : "Structured denomination cluster",
        confidence,
        reason: targetIsKnownMixer
          ? "Known mixer адрес делает denomination withdrawals на разные адреса"
          : "Одинаковые denomination withdrawals на разные адреса; без known mixer label это структурный признак",
        txs: sample.slice(0, 5),
      });
      break;
    }
  }

  for (let index = 0; index < outgoing.length; index += 1) {
    const baseTx = outgoing[index];
    const window = outgoing.filter((tx) =>
      tx.timestamp >= baseTx.timestamp &&
      tx.timestamp - baseTx.timestamp <= oneHourMs &&
      txAssetKey(tx) === txAssetKey(baseTx)
    );

    if (window.length < 4) {
      continue;
    }

    const uniqueRecipients = new Set(window.map((tx) => tx.toLower).filter(Boolean));
    const freshShare = window.length ? window.filter(isFreshCounterparty).length / window.length : 0;
    const medianLike = window.filter((tx) => amountSimilarityPercent(baseTx.amount, tx.amount) >= 70);

    if (!targetIsService && uniqueRecipients.size >= 4 && freshShare >= 0.75 && medianLike.length >= 3) {
      const flag = targetIsKnownMixer ? "mixer_fresh_wallet_fanout" : "fresh_wallet_fanout";
      const confidence = targetIsKnownMixer
        ? Math.min(96, 64 + window.length * 4 + Math.round(freshShare * 12))
        : Math.min(74, 48 + window.length * 3 + Math.round(freshShare * 8));
      const sample = window.slice(0, 8);

      for (const tx of sample) {
        mark(tx.hash, flag);
        if (targetIsKnownMixer) {
          mark(tx.hash, "possible_mixer_flow");
        }
      }

      if (targetIsKnownMixer) {
        mixerHeuristicFindings.push({
          type: "fresh_wallet_fanout",
          confidence,
          count: window.length,
        });
      }

      addFactor({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer fresh-wallet fanout" : "Fresh-wallet fanout",
        points: targetIsKnownMixer ? Math.min(30, 16 + window.length * 3) : Math.min(16, 7 + window.length * 2),
        confidence,
        description: targetIsKnownMixer
          ? `${window.length} исходящих переводов за 1 час на ${uniqueRecipients.size} адресов; ${Math.round(freshShare * 100)}% адресов встречены только один раз`
          : `${window.length} исходящих переводов на fresh wallets. Это может быть distribution/fanout и не считается миксером без known mixer label.`,
        txHashes: sample.slice(0, 5).map((tx) => tx.hash),
      });

      addRoute({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer fresh-wallet fanout" : "Fresh-wallet fanout",
        confidence,
        reason: targetIsKnownMixer
          ? "Known mixer адрес распределяет средства на новые одноразовые адреса"
          : "Средства распределяются на новые одноразовые адреса; без known mixer label это distribution pattern",
        txs: sample.slice(0, 5),
      });
      break;
    }
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const anchor = sorted[index];
    const window = sorted.filter((tx) =>
      tx.timestamp >= anchor.timestamp &&
      tx.timestamp - anchor.timestamp <= sixHoursMs &&
      txAssetKey(tx) === txAssetKey(anchor)
    );
    const inputs = window.filter((tx) => tx.direction === "in" && tx.amount > 0n);
    const outputs = window.filter((tx) => tx.direction === "out" && tx.amount > 0n);
    const uniqueSenders = new Set(inputs.map((tx) => tx.fromLower).filter(Boolean));
    const uniqueRecipients = new Set(outputs.map((tx) => tx.toLower).filter(Boolean));

    if (inputs.length < 3 || outputs.length < 3 || uniqueSenders.size < 3 || uniqueRecipients.size < 3) {
      continue;
    }

    const inputSum = inputs.reduce((sum, tx) => sum + tx.amount, 0n);
    const outputSum = outputs.reduce((sum, tx) => sum + tx.amount, 0n);
    const sumRatio = amountSimilarityPercent(inputSum, outputSum);
    const repeatedOutputDenoms = outputs.filter((tx, _, list) =>
      list.filter((other) => other.hash !== tx.hash && amountSimilarityPercent(other.amount, tx.amount) >= 95).length >= 1
    );

    if (!targetIsService && sumRatio >= 75 && repeatedOutputDenoms.length >= 3) {
      const flag = targetIsKnownMixer ? "mixer_pool_behavior" : "pool_like_flow";
      const confidence = targetIsKnownMixer
        ? Math.min(98, 70 + inputs.length * 3 + outputs.length * 3)
        : Math.min(80, 52 + inputs.length * 2 + outputs.length * 2);
      const sample = [...inputs.slice(0, 3), ...outputs.slice(0, 4)];

      for (const tx of sample) {
        mark(tx.hash, flag);
        if (targetIsKnownMixer) {
          mark(tx.hash, "possible_mixer_flow");
        }
      }

      if (targetIsKnownMixer) {
        mixerHeuristicFindings.push({
          type: "pool_behavior",
          confidence,
          count: inputs.length + outputs.length,
        });
      }

      addFactor({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer pool behavior" : "Pool-like fan-in/fan-out",
        points: targetIsKnownMixer ? 36 : 18,
        confidence,
        description: targetIsKnownMixer
          ? `${inputs.length} входов от ${uniqueSenders.size} отправителей и ${outputs.length} выходов на ${uniqueRecipients.size} получателей; суммы вход/выход совпадают на ${sumRatio.toFixed(1)}%`
          : `${inputs.length} входов и ${outputs.length} выходов похожи на pool-flow. Без known mixer label это не подтверждение миксера.`,
        txHashes: sample.map((tx) => tx.hash),
      });

      addRoute({
        type: flag,
        title: targetIsKnownMixer ? "Known mixer pool behavior" : "Pool-like flow",
        confidence,
        reason: targetIsKnownMixer
          ? "Known mixer адрес консолидирует входы и выдает похожие denomination outputs"
          : "Одновременная консолидация входов и похожие outputs; классифицировано как pool-like flow",
        txs: sample,
      });
      break;
    }
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index];
    if (candidate.direction !== "out") {
      continue;
    }

    const prevIncoming = sorted
      .slice(0, index)
      .filter((tx) => tx.direction === "in" && candidate.timestamp - tx.timestamp <= sixHoursMs);

    const fanInSimilar = prevIncoming.filter((tx) => amountSimilarityPercent(candidate.amount, tx.amount) >= 55);

    if (fanInSimilar.length >= 3) {
      mark(candidate.hash, "fan_in");
      addFactor({
        type: "fan_in",
        title: "Fan-in",
        points: 14,
        confidence: Math.min(92, 55 + fanInSimilar.length * 7),
        description: `${fanInSimilar.length} входящих переводов перед одним выходом`,
        txHashes: [candidate.hash, ...fanInSimilar.slice(0, 3).map((tx) => tx.hash)],
      });

      addRoute({
        type: "fan_in",
        title: "Fan-in маршрут",
        confidence: Math.min(92, 55 + fanInSimilar.length * 7),
        reason: `${fanInSimilar.length} входов консолидируются в один выход`,
        txs: [...fanInSimilar.slice(0, 3), candidate],
      });
      break;
    }
  }

  for (const tx of sorted) {
    if (tx.isRound) {
      mark(tx.hash, "round_amount");
    }
  }

  const fastPairs = [...byHash.values()].filter((flags) => flags.includes("fast_out")).length;
  const mixerHits = entityHits.filter((hit) => ["mixer", "tornado", "privacy"].includes(hit.category));
  const bridgeHits = entityHits.filter((hit) => hit.category === "bridge");
  const exchangeHits = entityHits.filter((hit) => ["exchange", "cex"].includes(hit.category));
  const exitCandidates = [...exitScores.values()].sort((a, b) => b.probability - a.probability).slice(0, 12);
  const transitCounterparties = [...counterpartyStats.values()]
    .filter((stats) => stats.inbound > 0 && stats.outbound > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const fanOutCount = [...byHash.values()].filter((flags) => flags.includes("fan_out")).length;
  const fanInCount = [...byHash.values()].filter((flags) => flags.includes("fan_in")).length;
  const roundAmountCount = [...byHash.values()].filter((flags) => flags.includes("round_amount")).length;
  const bridgeHopCount = [...byHash.values()].filter((flags) => flags.includes("bridge_hop")).length;
  const exchangeCashoutCount = [...byHash.values()].filter((flags) => flags.includes("exchange_cashout")).length;
  const exchangeDepositCount = [...byHash.values()].filter((flags) => flags.includes("exchange_deposit")).length;
  const exchangeDeanonymizationCount = [...byHash.values()].filter((flags) => flags.includes("exchange_deanonymization")).length;
  const mixerToExchangeCount = [...byHash.values()].filter((flags) => flags.includes("mixer_to_exchange")).length;
  const mixerEqualizedWithdrawalCount = [...byHash.values()].filter((flags) => flags.includes("mixer_equalized_withdrawal")).length;
  const mixerDenominationClusterCount = [...byHash.values()].filter((flags) => flags.includes("mixer_denomination_cluster")).length;
  const mixerFreshWalletFanoutCount = [...byHash.values()].filter((flags) => flags.includes("mixer_fresh_wallet_fanout")).length;
  const mixerPoolBehaviorCount = [...byHash.values()].filter((flags) => flags.includes("mixer_pool_behavior")).length;
  const directMixerConfidence = mixerHits.length ? Math.min(98, 70 + mixerHits.length * 6) : 0;
  const mixerHeuristicConfidence = Math.max(directMixerConfidence, ...mixerHeuristicFindings.map((finding) => finding.confidence || 0));
  const tokenTransferCount = sorted.filter((tx) => tx.isTokenTransfer).length;
  const stablecoinTransferCount = sorted.filter((tx) => tx.isStablecoin).length;
  const stablecoinFastExitCount = [...byHash.values()].filter((flags) => flags.includes("stablecoin_fast_out")).length;

  if (fastPairs) {
    signals.push({
      type: "fast_transfer",
      severity: fastPairs >= 3 ? "high" : "medium",
      title: "Быстрые переводы",
      description: `${fastPairs} исходящих переводов после входа с близкой суммой в течение часа`,
      confidence: Math.min(94, 58 + fastPairs * 9),
    });
  }

  if (fanOutCount) {
    signals.push({
      type: "fan_out",
      severity: fanOutCount >= 2 ? "high" : "medium",
      title: "Дробление средств",
      description: `${fanOutCount} адресов/узлов имеют fan-out паттерн`,
      confidence: Math.min(95, 58 + fanOutCount * 8),
    });
  }

  if (fanInCount) {
    signals.push({
      type: "fan_in",
      severity: "medium",
      title: "Консолидация средств",
      description: `${fanInCount} выходов выглядят как fan-in консолидация`,
      confidence: Math.min(90, 50 + fanInCount * 7),
    });
  }

  if (roundAmountCount) {
    signals.push({
      type: "round_amount",
      severity: "low",
      title: "Round amounts",
      description: `${roundAmountCount} транзакций имеют округленную сумму`,
      confidence: Math.min(82, 40 + roundAmountCount * 6),
    });
  }

  if (mixerHits.length) {
    signals.push({
      type: "known_mixer_contact",
      severity: "high",
      title: "Контакт с известным миксером",
      description: `${mixerHits.length} транзакций совпали с локальной базой mixer-адресов`,
      confidence: directMixerConfidence,
    });
  }

  if (bridgeHits.length) {
    signals.push({
      type: "known_bridge_contact",
      severity: "medium",
      title: "Контакт с bridge",
      description: `${bridgeHits.length} транзакций совпали с локальной базой bridge-адресов`,
      confidence: Math.min(90, 55 + bridgeHits.length * 5),
    });
  }

  if (exchangeHits.length) {
    signals.push({
      type: "known_exchange_contact",
      severity: "medium",
      title: "Контакт с биржей",
      description: `${exchangeHits.length} транзакций совпали с локальной базой exchange-адресов`,
      confidence: Math.min(88, 50 + exchangeHits.length * 4),
    });
  }

  if (bridgeHopCount) {
    signals.push({
      type: "bridge_hop",
      severity: "medium",
      title: "Bridge hop",
      description: `${bridgeHopCount} транзакций проходят через bridge-паттерн`,
      confidence: Math.min(92, 54 + bridgeHopCount * 5),
    });
  }

  if (exchangeCashoutCount) {
    signals.push({
      type: "exchange_cashout",
      severity: "high",
      title: "Exchange cash-out",
      description: `${exchangeCashoutCount} транзакций указывают на cash-out на биржу`,
      confidence: Math.min(95, 60 + exchangeCashoutCount * 5),
    });
  }

  if (exchangeDeanonymizationCount) {
    signals.push({
      type: "exchange_deanonymization",
      severity: mixerToExchangeCount ? "high" : "medium",
      title: "Деанонимизация через биржу",
      description: `${exchangeDeanonymizationCount} транзакций выглядят как депозит на CEX, который может связать адрес с KYC аккаунтом`,
      confidence: Math.min(96, 62 + exchangeDeanonymizationCount * 6 + mixerToExchangeCount * 10),
    });
  } else if (exchangeDepositCount) {
    signals.push({
      type: "exchange_deposit",
      severity: "medium",
      title: "Депозит на биржу",
      description: `${exchangeDepositCount} исходящих переводов идут на известную биржу`,
      confidence: Math.min(86, 55 + exchangeDepositCount * 4),
    });
  }

  if (stablecoinFastExitCount) {
    signals.push({
      type: "stablecoin_fast_exit",
      severity: stablecoinFastExitCount >= 2 ? "high" : "medium",
      title: "Быстрый stablecoin exit",
      description: `${stablecoinFastExitCount} stablecoin переводов быстро вышли после входа с близкой суммой`,
      confidence: Math.min(94, 60 + stablecoinFastExitCount * 8),
    });
  }

  if (stablecoinTransferCount >= 5) {
    signals.push({
      type: "stablecoin_activity",
      severity: "medium",
      title: "Stablecoin-heavy activity",
      description: `${stablecoinTransferCount} ERC-20/TRC-20 stablecoin transfers в загруженном диапазоне`,
      confidence: Math.min(88, 50 + stablecoinTransferCount * 3),
    });
  }

  if (mixerToExchangeCount) {
    signals.push({
      type: "mixer_to_exchange",
      severity: "high",
      title: "Mixer-flow на биржу",
      description: `${mixerToExchangeCount} переводов связывают known mixer источник с последующим CEX депозитом`,
      confidence: Math.min(98, 74 + mixerToExchangeCount * 8),
    });
  }

  if (mixerEqualizedWithdrawalCount) {
    signals.push({
      type: "mixer_equalized_withdrawal",
      severity: "high",
      title: "Mixer-style withdrawals",
      description: `${mixerEqualizedWithdrawalCount} транзакций похожи на выдачу из mixer/pool одинаковыми суммами`,
      confidence: Math.min(98, 70 + mixerEqualizedWithdrawalCount * 5),
    });
  }

  if (mixerHeuristicFindings.length) {
    signals.push({
      type: "mixer_heuristic_engine",
      severity: mixerHeuristicConfidence >= 88 ? "high" : "medium",
      title: "Mixer heuristic match",
      description: [
        mixerDenominationClusterCount ? `${mixerDenominationClusterCount} denomination-cluster tx` : "",
        mixerFreshWalletFanoutCount ? `${mixerFreshWalletFanoutCount} fresh-wallet fanout tx` : "",
        mixerPoolBehaviorCount ? `${mixerPoolBehaviorCount} pool-behavior tx` : "",
      ].filter(Boolean).join(", "),
      confidence: mixerHeuristicConfidence,
    });
  }

  if (transitCounterparties.length) {
    signals.push({
      type: "transit_counterparties",
      severity: "medium",
      title: "Транзитные связи",
      description: `${transitCounterparties.length} контрагентов имеют входящие и исходящие связи с адресом`,
      confidence: Math.min(88, 50 + transitCounterparties.length * 5),
    });
  }

  if (exitCandidates.length) {
    signals.push({
      type: "exit_candidates",
      severity: "high",
      title: "Кандидаты exit-address",
      description: `${exitCandidates.length} адресов похожи на выход после транзита или миксер-подобного окна`,
      confidence: exitCandidates[0].probability,
    });
  }

  const groupedRiskFactors = groupDuplicateRiskFactors(riskFactors);
  const totalFactorPoints = groupedRiskFactors.reduce((sum, factor) => sum + factor.points, 0);
  const routeBonus = suspiciousRoutes.reduce((sum, route) => sum + Math.min(8, Math.round(route.confidence / 20)), 0);
  const riskScore = sorted.length
    ? Math.min(
        99,
        18 +
          totalFactorPoints +
          routeBonus +
          signals.reduce((score, signal) => score + (signal.severity === "high" ? 18 : signal.severity === "medium" ? 10 : 4), 0) +
          Math.min(20, exitCandidates.length * 3)
      )
    : 0;

  const topRoutes = suspiciousRoutes.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const topFactors = groupedRiskFactors.sort((a, b) => b.points - a.points).slice(0, 12);

  return {
    riskScore,
    signals,
    exitCandidates,
    entityHits,
    transitCounterparties,
    riskFactors: topFactors,
    suspiciousRoutes: topRoutes,
    transactionFlags: Object.fromEntries(byHash),
    summary: {
      analyzedTransactions: sorted.length,
      spamTokenExcludedCount: spamTokenCount,
      fastTransferCount: fastPairs,
      splitTransactionCount: [...byHash.values()].filter((flags) => flags.includes("split")).length,
      exitCandidateCount: exitCandidates.length,
      transitCounterpartyCount: transitCounterparties.length,
      mixerHitCount: mixerHits.length,
      bridgeHitCount: bridgeHits.length,
      exchangeHitCount: exchangeHits.length,
      fanOutCount,
      fanInCount,
      roundAmountCount,
      bridgeHopCount,
      exchangeCashoutCount,
      exchangeDepositCount,
      exchangeDeanonymizationCount,
      mixerToExchangeCount,
      mixerEqualizedWithdrawalCount,
      mixerDenominationClusterCount,
      mixerFreshWalletFanoutCount,
      mixerPoolBehaviorCount,
      mixerHeuristicConfidence,
      tokenTransferCount,
      stablecoinTransferCount,
      stablecoinFastExitCount,
      suspiciousRouteCount: topRoutes.length,
      riskFactorCount: topFactors.length,
    },
  };
}

function groupDuplicateRiskFactors(factors = []) {
  const groups = new Map();

  for (const factor of factors) {
    const key = [
      factor.type || "",
      factor.title || "",
      factor.description || "",
      factor.source || "",
      Number(factor.points || 0),
      Number(factor.confidence || 0),
    ].join("\u0001");
    const txHashes = Array.isArray(factor.txHashes) ? factor.txHashes : [];
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        ...factor,
        count: 1,
        txHashes: [...new Set(txHashes)],
      });
      continue;
    }

    existing.count += 1;
    existing.txHashes = [...new Set([...(existing.txHashes || []), ...txHashes])];
  }

  return [...groups.values()].map((factor) => {
    if ((factor.count || 1) <= 1) {
      return factor;
    }

    const basePoints = Number(factor.points || 0);
    const baseConfidence = Number(factor.confidence || 70);
    const extraPoints = Math.min(9, (factor.count - 1) * 3);

    return {
      ...factor,
      points: Math.min(99, basePoints + extraPoints),
      confidence: Math.min(95, baseConfidence + (factor.count - 1) * 3),
      description: `${factor.description} Сгруппировано ${factor.count} однотипных tx.`,
    };
  });
}

function clampScore(value) {
  return Math.max(0, Math.min(99, Math.round(value || 0)));
}

function riskLevel(score) {
  if (score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}

const riskCategoryMeta = {
  illicit_exposure: {
    title: "Illicit exposure",
    maxPoints: 36,
    description: "Mixer, scam, sanctions, exploit or direct high-risk attribution",
  },
  laundering_behavior: {
    title: "Laundering behavior",
    maxPoints: 24,
    description: "Fast exit, amount matching and transit-like routes",
  },
  structuring: {
    title: "Structuring",
    maxPoints: 18,
    description: "Fan-out, fan-in, splitting and round amount patterns",
  },
  service_hops: {
    title: "Service hops",
    maxPoints: 14,
    description: "Bridge, exchange, swap and cash-out touchpoints",
  },
  graph_context: {
    title: "Graph context",
    maxPoints: 16,
    description: "Risky graph neighbors, graph density and node degree",
  },
};

function riskCategoryForFactor(factor) {
  const type = factor?.type || "";
  const source = factor?.source || "";

  if (/sanction|scam|mixer|exploit|hack|phish|ransom|launder|high_risk|direct_entity/.test(type)) {
    return "illicit_exposure";
  }

  if (/fast|time_correlation|amount_similarity|exit_candidate|mixer_chain|mixer_to_exchange|exchange_deanonymization/.test(type)) {
    return "laundering_behavior";
  }

  if (/fan_out|fan_in|split|round_amount/.test(type)) {
    return "structuring";
  }

  if (/bridge|exchange|cashout|service|arkham_service|cex/.test(type)) {
    return "service_hops";
  }

  if (source === "graph" || type.startsWith('graph_')) {
    return "graph_context";
  }

  return "laundering_behavior";
}

function signalCategory(signal) {
  const type = signal?.type || "";

  if (/mixer|scam|sanction|exploit/.test(type)) return "illicit_exposure";
  if (/fast|exit|transit|deanonymization|cex/.test(type)) return "laundering_behavior";
  if (/fan|split|round/.test(type)) return "structuring";
  if (/bridge|exchange|cash/.test(type)) return "service_hops";
  return "laundering_behavior";
}

function signalPoints(signal) {
  const severity = signal?.severity || "low";
  const base = severity === "high" ? 9 : severity === "medium" ? 5 : 2;
  return base * Math.max(0.35, Math.min(1, Number(signal?.confidence || 60) / 100));
}

function buildRiskModelV2({ factors, signals, coverage, graphDensityBonus }) {
  const categories = Object.fromEntries(
    Object.entries(riskCategoryMeta).map(([key, meta]) => [
      key,
      {
        key,
        ...meta,
        score: 0,
        factorCount: 0,
        topFactors: [],
      },
    ])
  );

  for (const factor of factors) {
    const categoryKey = riskCategoryForFactor(factor);
    const category = categories[categoryKey] || categories.laundering_behavior;
    const confidenceWeight = Math.max(0.35, Math.min(1, Number(factor.confidence || 65) / 100));
    const weightedPoints = Number(factor.points || 0) * confidenceWeight;

    category.score = Math.min(category.maxPoints, category.score + weightedPoints);
    category.factorCount += 1;
    category.topFactors.push({
      type: factor.type,
      title: factor.title,
      points: Math.round(weightedPoints),
      confidence: factor.confidence,
      source: factor.source || "transactions",
    });
  }

  for (const signal of signals || []) {
    const categoryKey = signalCategory(signal);
    const category = categories[categoryKey] || categories.laundering_behavior;
    const points = signalPoints(signal);

    category.score = Math.min(category.maxPoints, category.score + points);
    category.factorCount += 1;
    category.topFactors.push({
      type: signal.type,
      title: signal.title,
      points: Math.round(points),
      confidence: signal.confidence,
      source: "signals",
    });
  }

  if (graphDensityBonus) {
    categories.graph_context.score = Math.min(
      categories.graph_context.maxPoints,
      categories.graph_context.score + graphDensityBonus
    );
  }

  const activeCoverage = Object.values(coverage || {}).filter(Boolean).length;
  const dataQualityConfidence = clampScore((activeCoverage / Math.max(1, Object.keys(coverage || {}).length)) * 100);
  const insufficientData = !(coverage?.transactions || coverage?.graph || coverage?.arkham);
  const categoryList = Object.values(categories).map((category) => ({
    ...category,
    score: clampScore(category.score),
    topFactors: category.topFactors.sort((a, b) => b.points - a.points).slice(0, 4),
  }));
  const total = categoryList.reduce((sum, category) => sum + category.score, 0);
  const score = clampScore(total);

  return {
    version: "v2-weighted-categories",
    score,
    level: riskLevel(score),
    dataQualityConfidence,
    insufficientData,
    categories: categoryList,
    weights: Object.fromEntries(Object.entries(riskCategoryMeta).map(([key, meta]) => [key, meta.maxPoints])),
    rules: [
      "Direct mixer/scam/sanctions attribution has the strongest impact.",
      "Fast exit and close amount matching increase laundering behavior.",
      "Fan-out, fan-in and repeated similar transfers increase structuring risk.",
      "Bridge/exchange contact is weighted as service-hop context, not automatically illicit.",
      "Graph and analyst context raise confidence when transaction data is thin.",
    ],
  };
}

function arkhamRiskSignals(intelligence) {
  const values = [
    ...(intelligence?.entities || []),
    ...(intelligence?.labels || []),
    ...(intelligence?.tags || []),
  ];
  const exchangeTerms = [
    "binance",
    "coinbase",
    "okx",
    "kraken",
    "bybit",
    "kucoin",
    "bitget",
    "bitfinex",
    "mexc",
    "gate.io",
    "gateio",
    "htx",
    "huobi",
    "crypto.com",
    "cex",
    "exchange",
  ];
  const mixerTerms = ["mixer", "tornado", "privacy", "railgun", "coinjoin", "mixing"];
  const bridgeTerms = ["bridge", "stargate", "hop protocol", "across", "synapse", "wormhole", "layerzero"];
  const highRiskTerms = [
    "mixer",
    "tornado",
    "sanction",
    "scam",
    "exploit",
    "hack",
    "phish",
    "ransom",
    "launder",
    "darknet",
    "fraud",
    "terror",
  ];
  const mediumRiskTerms = ["bridge", "swap", "gambling", "casino", "proxy", "cex", "exchange", "otc"];

  return values
    .map((item) => {
      const text = [item.name, item.type, item.id].filter(Boolean).join(" ").toLowerCase();
      const highTerm = highRiskTerms.find((term) => text.includes(term));
      const mediumTerm = mediumRiskTerms.find((term) => text.includes(term));
      const exchangeTerm = exchangeTerms.find((term) => text.includes(term));
      const mixerTerm = mixerTerms.find((term) => text.includes(term));
      const bridgeTerm = bridgeTerms.find((term) => text.includes(term));

      if (highTerm || mixerTerm) {
        return {
          type: "arkham_high_risk_label",
          title: "Arkham high-risk attribution",
          points: mixerTerm ? 34 : 28,
          confidence: 92,
          description: `Arkham label/entity contains "${highTerm || mixerTerm}": ${item.name || item.id || "unknown"}`,
          source: "arkham",
        };
      }

      if (exchangeTerm) {
        return {
          type: "arkham_exchange_label",
          title: "Arkham exchange attribution",
          points: 14,
          confidence: 82,
          description: `Arkham attribution matches exchange term "${exchangeTerm}": ${item.name || item.id || "unknown"}`,
          source: "arkham",
        };
      }

      if (mediumTerm || bridgeTerm) {
        return {
          type: "arkham_service_label",
          title: "Arkham service attribution",
          points: bridgeTerm ? 13 : 10,
          confidence: 72,
          description: `Arkham attribution contains "${mediumTerm || bridgeTerm}": ${item.name || item.id || "unknown"}`,
          source: "arkham",
        };
      }

      return null;
    })
    .filter(Boolean);
}

function graphRiskSignals(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const riskNodes = nodes.filter((node) => {
    const category = node.manualLabel?.category || "";
    const arkhamText = [
      node.nametag,
      ...(node.arkham?.entities || []).map((item) => item.name || item.type),
      ...(node.arkham?.labels || []).map((item) => item.name || item.type),
      ...(node.arkham?.tags || []).map((item) => item.name || item.type),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      ["mixer", "scam", "bridge", "exchange"].includes(category) ||
      /mixer|tornado|sanction|scam|exploit|hack|phish|ransom|launder/.test(arkhamText)
    );
  });
  const highRiskNodes = riskNodes.filter((node) => ["mixer", "scam"].includes(node.manualLabel?.category || ""));
  const serviceNodes = riskNodes.filter((node) => ["bridge", "exchange"].includes(node.manualLabel?.category || ""));
  const fanOutParents = new Map();
  const fanInTargets = new Map();

  for (const edge of edges) {
    fanOutParents.set(edge.from, (fanOutParents.get(edge.from) || 0) + 1);
    fanInTargets.set(edge.to, (fanInTargets.get(edge.to) || 0) + 1);
  }

  const maxFanOut = Math.max(0, ...fanOutParents.values());
  const maxFanIn = Math.max(0, ...fanInTargets.values());
  const factors = [];

  if (highRiskNodes.length) {
    factors.push({
      type: "graph_high_risk_entity",
      title: "Risk entity in graph",
      points: Math.min(30, 18 + highRiskNodes.length * 4),
      confidence: Math.min(96, 78 + highRiskNodes.length * 4),
      description: `${highRiskNodes.length} graph nodes match mixer/scam labels`,
      source: "graph",
    });
  }

  if (serviceNodes.length) {
    factors.push({
      type: "graph_service_entity",
      title: "Service entity in graph",
      points: Math.min(18, 8 + serviceNodes.length * 2),
      confidence: Math.min(88, 60 + serviceNodes.length * 4),
      description: `${serviceNodes.length} graph nodes match bridge/exchange labels`,
      source: "graph",
    });
  }

  if (maxFanOut >= 5) {
    factors.push({
      type: "graph_fan_out_degree",
      title: "Graph fan-out",
      points: Math.min(20, 8 + maxFanOut),
      confidence: Math.min(90, 55 + maxFanOut * 4),
      description: `One graph node has ${maxFanOut} outgoing edges`,
      source: "graph",
    });
  }

  if (maxFanIn >= 5) {
    factors.push({
      type: "graph_fan_in_degree",
      title: "Graph fan-in",
      points: Math.min(16, 6 + maxFanIn),
      confidence: Math.min(88, 52 + maxFanIn * 4),
      description: `One graph node has ${maxFanIn} incoming edges`,
      source: "graph",
    });
  }

  return factors;
}

async function buildWalletRisk({ address, networkKey, mode = "full" }) {
  const fastMode = mode === "fast";
  const entityLabels = await readEntityLabels();
  const watchlistRules = await readJson(watchlistRulesFile);
  const cases = await readJson(investigationCasesFile);
  const errors = [];
  const coverage = {
    transactions: false,
    graph: false,
    arkham: false,
    entityLabels: entityLabels.length > 0,
    watchlist: watchlistRules.length > 0,
    cases: cases.length > 0,
  };
  let transactions = { items: [] };
  let graph = null;
  let arkham = null;

  try {
    if (networkKey === "TRX" || isTronAddress(address)) {
      transactions = await getTransactionsWithCache({
        address,
        networkKey: "TRX",
        page: 1,
        limit: fastMode ? 30 : 80,
        fingerprint: "",
        includeDust: false,
        minAmountSun: tronDustMinSun,
      });
    } else if (isEvmAddress(address)) {
      transactions = await getTransactionsWithCache({
        address,
        networkKey,
        page: 1,
        limit: fastMode ? 30 : 80,
      });
    }

    coverage.transactions = Boolean(transactions.items?.length);
  } catch (error) {
    errors.push(`transactions: ${error.message}`);
  }

  const transactionAnalysis = analyzeTransactions(address, transactions.items || [], entityLabels);

  if (!fastMode) {
    try {
      graph = await buildWalletGraph({
        address,
        networkKey,
        depth: 2,
        maxNodes: 80,
        perAddressLimit: 8,
      });
      coverage.graph = Boolean(graph.nodes?.length);
      if (graph.errors?.length) {
        errors.push(...graph.errors.slice(0, 4).map((item) => `graph: ${item}`));
      }
    } catch (error) {
      errors.push(`graph: ${error.message}`);
    }
  }

  if (!fastMode && isEvmAddress(address)) {
    try {
      arkham = await getArkhamAddressIntelligence(address);
      coverage.arkham = Boolean((arkham.entities || []).length || (arkham.labels || []).length || (arkham.tags || []).length);
    } catch (error) {
      errors.push(`arkham: ${error.message}`);
    }
  }

  const lowerAddress = address.toLowerCase();
  const requestedNetworkKey = String(networkKey || "ALL").toUpperCase();
  const directEntityLabels = entityLabels.filter((label) => {
    const labelNetworkKey = String(label.networkKey || "UNKNOWN").toUpperCase();

    return (
      label.address?.toLowerCase() === lowerAddress &&
      (
        requestedNetworkKey === "ALL" ||
        labelNetworkKey === requestedNetworkKey ||
        labelNetworkKey === "ALL" ||
        labelNetworkKey === "UNKNOWN"
      )
    );
  });
  const directSanctionsLabels = directEntityLabels.filter(isSanctionsEntityLabel);
  const relatedRules = watchlistRules.filter((rule) => rule.address?.toLowerCase() === lowerAddress);
  const relatedCases = cases.filter((item) => item.rootAddress?.toLowerCase() === lowerAddress);
  const externalFactors = [
    ...arkhamRiskSignals(arkham),
    ...graphRiskSignals(graph),
  ];

  for (const label of directEntityLabels) {
    const category = normalizeEntityCategory(label.category);
    const sanctionsLabel = isSanctionsEntityLabel(label);
    const labelConfidence = Number(label.confidence) || 80;
    const categoryPoints = {
      sanctions: 80,
      mixer: 34,
      tornado: 34,
      privacy: 30,
      scam: 80,
      bridge: 16,
      exchange: 12,
      cex: 12,
      service: 2,
      benign: 1,
    };
    const labelTitle = sanctionsLabel
      ? "OFAC sanctions match"
      : category === "service"
        ? "Service entity label"
        : category === "benign"
          ? "Benign entity label"
          : "Direct entity label";
    externalFactors.push({
      type: sanctionsLabel ? "direct_sanctions_label" : category === "service" ? "direct_service_label" : `direct_${category}_label`,
      title: labelTitle,
      points: sanctionsLabel ? 80 : categoryPoints[category] || 10,
      confidence: sanctionsLabel ? Math.max(95, labelConfidence) : labelConfidence,
      description: sanctionsLabel
        ? `Address is listed in sanctions data: ${label.name || label.address}`
        : `Address is labeled as ${category || "entity"}: ${label.name || label.address}`,
      source: sanctionsLabel && String(label.source || "").startsWith("ofac-sls:") ? "ofac_sls" : "entity_labels",
    });
  }

  const graphDensityBonus = graph?.stats?.edgeCount && graph?.stats?.nodeCount
    ? Math.min(10, Math.round((graph.stats.edgeCount / Math.max(1, graph.stats.nodeCount)) * 3))
    : 0;
  const riskFactors = [
    ...(transactionAnalysis.riskFactors || []).map((factor) => ({ ...factor, source: factor.source || "transactions" })),
    ...externalFactors,
  ]
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 16);
  const transactionScore = transactionAnalysis.riskScore || 0;
  const externalPoints = externalFactors.reduce((sum, factor) => sum + factor.points, 0);
  const legacyScore = clampScore(
    transactionScore * 0.68 +
      externalPoints +
      graphDensityBonus -
      (coverage.transactions || coverage.graph || coverage.arkham ? 0 : 18)
  );
  const riskModel = buildRiskModelV2({
    factors: riskFactors,
    signals: transactionAnalysis.signals || [],
    coverage,
    graphDensityBonus,
  });
  const sanctionsScoreFloor = directSanctionsLabels.length ? 80 : 0;
  const riskScore = Math.max(riskModel.score, sanctionsScoreFloor);
  const scoreFloorApplied = sanctionsScoreFloor > riskModel.score;

  return {
    address,
    networkKey,
    riskModelVersion,
    calculationMode: fastMode ? "fast" : "full",
    riskScore,
    riskLevel: riskLevel(riskScore),
    confidence: clampScore(
      25 +
        (coverage.transactions ? 30 : 0) +
        (coverage.graph ? 20 : 0) +
        (coverage.arkham ? 15 : 0) +
        (coverage.entityLabels ? 5 : 0) +
        (directSanctionsLabels.length ? 40 : 0)
    ),
    coverage,
    providerScores: {
      transactions: transactionScore,
      externalSignals: clampScore(externalPoints),
      graphDensity: graphDensityBonus,
      sanctionsFloor: sanctionsScoreFloor,
      legacyScore,
    },
    scoreFloor: scoreFloorApplied
      ? {
          type: "direct_sanctions_label",
          minimumScore: sanctionsScoreFloor,
          matchedLabels: directSanctionsLabels.length,
        }
      : null,
    explanation: {
      summary: riskFactors.length
        ? `Score ${riskScore} is driven by ${riskFactors.slice(0, 3).map((factor) => factor.title).join(", ")}.`
        : `Score ${riskScore} is low because no strong risk factors were found in available sources.`,
      usedSources: Object.entries(coverage)
        .filter(([, active]) => active)
        .map(([key]) => key),
      missingSources: Object.entries(coverage)
        .filter(([, active]) => !active)
        .map(([key]) => key),
      topFactorTitles: riskFactors.slice(0, 5).map((factor) => ({
        title: factor.title,
        points: factor.points,
        source: factor.source || "unknown",
      })),
    },
    riskModel,
    signals: transactionAnalysis.signals || [],
    riskFactors,
    exitCandidates: transactionAnalysis.exitCandidates || [],
    entityHits: transactionAnalysis.entityHits || [],
    suspiciousRoutes: transactionAnalysis.suspiciousRoutes || [],
    summary: {
      ...transactionAnalysis.summary,
      graphNodes: graph?.stats?.nodeCount || 0,
      graphEdges: graph?.stats?.edgeCount || 0,
      arkhamEntities: arkham?.entities?.length || 0,
      arkhamLabels: arkham?.labels?.length || 0,
      arkhamTags: arkham?.tags?.length || 0,
      directEntityLabelCount: directEntityLabels.length,
      watchlistRuleCount: relatedRules.length,
      savedCaseCount: relatedCases.length,
    },
    errors: [...new Set(errors)].slice(0, 8),
  };
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return {
      delivered: false,
      reason: "TELEGRAM_BOT_TOKEN is not configured",
    };
  }

  if (!chatId) {
    return {
      delivered: false,
      reason: "telegram chat id is empty",
    };
  }

  const response = await fetch(`${serviceProtocol}://${telegramApiHost}/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      disable_web_page_preview: true,
      text,
    }),
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    return {
      delivered: false,
      reason: payload.description || `Telegram HTTP ${response.status}`,
    };
  }

  return {
    delivered: true,
    telegramMessageId: payload.result?.message_id,
  };
}

function snapshotChanged(previous, current) {
  if (!previous) {
    return false;
  }

  return (
    previous.balanceRaw !== current.balanceRaw ||
    previous.txCount !== current.txCount ||
    previous.latestTxId !== current.latestTxId
  );
}

function parseAlertAmount(value) {
  let text = String(value || "");
  text = /\d,\d{1,8}(?:\D|$)/.test(text) && !text.includes(".") ? text.replace(",", ".") : text.replace(/,/g, "");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isSpamTokenMovement(snapshot) {
  const text = [
    snapshot.latestValue,
    snapshot.latestTokenSymbol,
    snapshot.latestTokenName,
  ].filter(Boolean).join(" ").toLowerCase();

  if (!text || snapshot.latestTokenType === "native") {
    return false;
  }

  return /t\.me|telegram|claim|reward|airdrop|bonus|visit|www\.|https?:\/\/|✅|\.life|\.xyz|\.top|\.vip/.test(text);
}

function movementMatchesRule(rule, current) {
  const eventType = String(rule.eventType || "Любое движение").toLowerCase();
  const direction = current.latestDirection || "";

  if (eventType.includes("вход") && direction && direction !== "in") {
    return false;
  }

  if (eventType.includes("исход") && direction && direction !== "out") {
    return false;
  }

  const assetScope = rule.assetScope || "all";

  if (assetScope === "native" && current.latestTokenType && current.latestTokenType !== "native") {
    return false;
  }

  if (assetScope === "tokens" && current.latestTokenType === "native") {
    return false;
  }

  if (assetScope === "stablecoins" && !["USDT", "USDC", "USDD"].includes(String(current.latestTokenSymbol || "").toUpperCase())) {
    return false;
  }

  if (rule.hideSpamTokens !== false && isSpamTokenMovement(current)) {
    return false;
  }

  const threshold = String(rule.amountLimit || "").trim().toLowerCase();

  if (threshold && threshold !== "any") {
    const minAmount = parseAlertAmount(threshold);
    const currentAmount = parseAlertAmount(current.latestValue);

    if (minAmount !== null && currentAmount !== null && currentAmount < minAmount) {
      return false;
    }
  }

  return true;
}

function formatAlertTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().replace(".000Z", "Z");
}

function buildAlertText(rule, previous, current) {
  const direction =
    current.latestDirection === "out"
      ? "Исходящее движение"
      : current.latestDirection === "in"
        ? "Входящее движение"
        : "Движение по адресу";
  const directionIcon = current.latestDirection === "out" ? "🔴" : current.latestDirection === "in" ? "🟢" : "🟡";
  const previousBalance = previous?.balance ? `${previous.balance} ${previous.symbol || current.symbol}` : "unknown";
  const currentBalance = current.balance ? `${current.balance} ${current.symbol}` : "unknown";
  const latestTime = formatAlertTime(current.latestTxAt);

  return [
    "🚨 ChainSentra",
    "",
    `${directionIcon} ${direction}`,
    `🌐 Сеть: ${current.networkName || "unknown"}`,
    `👛 Адрес: ${compactHash(current.address, 12, 10)}`,
    current.latestValue ? `💰 Сумма: ${current.latestValue}` : "",
    current.latestCounterparty ? `🔁 Контрагент: ${compactHash(current.latestCounterparty)}` : "",
    current.counterpartyEntity ? `🏢 Организация: ${current.counterpartyEntity.name} (${traceExitType(current.counterpartyEntity)})` : "",
    current.counterpartyEntity?.source ? `📚 Источник метки: ${current.counterpartyEntity.source}` : "",
    current.latestFrom ? `↗️ From: ${compactHash(current.latestFrom)}` : "",
    current.latestTo ? `↘️ To: ${compactHash(current.latestTo)}` : "",
    current.latestTxId ? `🔎 Tx: ${compactHash(current.latestTxId, 14, 10)}` : "",
    current.latestExplorerUrl ? `🔗 Explorer: ${current.latestExplorerUrl}` : "",
    latestTime ? `🕒 Время: ${latestTime}` : "",
    "",
    `📊 Баланс: ${previousBalance} → ${currentBalance}`,
    `🧾 Tx count: ${previous?.txCount ?? "unknown"} → ${current.txCount ?? "unknown"}`,
    `🧱 Блок: ${current.blockNumber || "unknown"}`,
    `⚙️ Провайдер: ${current.latestProvider || "live provider"}`,
    `📌 Правило: ${rule.eventType || "Любое движение"}`,
  ].filter(Boolean).join("\n");
}

async function appendAlertEvent(event) {
  return mutateStore(alertEventsFile, async (events) => ({
    items: [event, ...events],
    result: event,
  }));
}

async function pollWatchlist({ profileId } = {}) {
  const now = new Date().toISOString();
  const rules = (await readJson(watchlistRulesFile)).filter(
    (rule) => rule.active !== false && (!profileId || belongsToProfile(rule, profileId))
  );
  const state = await readJson(watchStateFile);
  const stateKeyFor = (ruleId, networkKey) => `${ruleId}:${networkKey || "default"}`;
  const stateByKey = new Map(state.map((item) => [item.stateKey || stateKeyFor(item.ruleId, item.networkKey), item]));
  const nextStateByKey = new Map(stateByKey);
  const alerts = [];
  const errors = [];
  const entityLabels = await readEntityLabels();

  for (const rule of rules) {
    try {
      const snapshots = await getRuleSnapshots(rule);

      for (const current of snapshots) {
        if (current.latestCounterparty) {
          current.counterpartyEntity = traceEntityForAddress(entityLabels, current.latestCounterparty, current.networkKey);
          current.counterpartyExitType = traceExitType(current.counterpartyEntity);
        }
        const stateKey = stateKeyFor(rule.id, current.networkKey);
        const previousState = stateByKey.get(stateKey);
        const previous = previousState?.snapshot;

        nextStateByKey.set(stateKey, {
          stateKey,
          ruleId: rule.id,
          address: rule.address,
          networkKey: current.networkKey,
          networkName: current.networkName,
          snapshot: current,
          updatedAt: now,
        });

        if (snapshotChanged(previous, current) && movementMatchesRule(rule, current)) {
          const text = buildAlertText(rule, previous, current);
          const telegram = await sendTelegramMessage(rule.telegramChatId, text);
          const alert = await appendAlertEvent({
            id: makeId("alert"),
            profileId: normalizeProfileId(rule.profileId || "default"),
            ruleId: rule.id,
            address: rule.address,
            networkKey: current.networkKey,
            networkName: current.networkName,
            eventType: rule.eventType || "Любое движение",
            amountLimit: rule.amountLimit || "",
            previous,
            current,
            telegram,
            createdAt: now,
          });

          alerts.push(alert);
        }
      }
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        address: rule.address,
        error: error.message,
      });
    }
  }

  await writeJson(watchStateFile, [...nextStateByKey.values()]);

  return {
    checkedRules: rules.length,
    alertsCreated: alerts.length,
    errors,
  };
}

let polling = false;

async function pollWatchlistSafely() {
  if (polling) {
    return;
  }

  polling = true;

  try {
    const result = await pollWatchlist();
    if (result.alertsCreated || result.errors.length) {
      logger.info("watchlist poll", result);
    }
  } catch (error) {
    logger.error("watchlist poll failed", error);
  } finally {
    polling = false;
  }
}

const assistantSectionGuides = {
  overview: "Обзор — начальный поиск адреса, хеша транзакции или кластера.",
  wallets: "Кошельки — сохранённые адреса и быстрый переход к их проверке.",
  wallet: "Карточка кошелька — сеть, баланс, токены, активность и первичная оценка риска.",
  transactions: "Транзакции — подтверждённые блокчейном входящие и исходящие операции. Адреса Откуда и Куда открывают историю следующего кошелька.",
  trace: "Трассировка — движение конкретной суммы по веткам. Первый переход является фактом, последующие связи после смешивания могут быть вероятностными.",
  graph: "Граф — связи адресов и транзакций в визуальном виде.",
  alerts: "Уведомления — наблюдение за адресами и фиксация новой активности.",
  api: "API — состояние источников блокчейн-данных и их ограничения.",
  mixers: "Миксеры — проверка контактов с известными сервисами смешивания и структурных признаков. Один паттерн сам по себе не доказывает использование миксера.",
  exchanges: "Биржи — сопоставление адреса с известными сервисами и подготовка основания для официального запроса.",
  sanctions: "Risk DB — известные санкционные и риск-метки с указанием источника.",
  cases: "Расследования — сохранённые материалы, маршруты и отчёты по делу.",
};

function assistantContextSummary(context = {}) {
  const section = String(context.section || "overview");
  const address = String(context.address || "").trim();
  const network = String(context.network || "").trim();

  return {
    section,
    pageGuide: assistantSectionGuides[section] || "Раздел проекта ChainSentra.",
    address: address || "не выбран",
    network: network || "не определена",
    pageUrl: String(context.pageUrl || "").slice(0, 500),
  };
}

function builtInAssistantReply(question, context = {}) {
  const text = String(question || "").trim();
  const query = text.toLowerCase();
  const summary = assistantContextSummary(context);
  const addressLine = summary.address === "не выбран"
    ? "Сначала укажите адрес в универсальном поиске."
    : `Сейчас выбран адрес ${summary.address}, сеть: ${summary.network}.`;

  if (/владел|кому принадлеж|фио|личност|чей кошел/.test(query)) {
    return `${addressLine}\n\nПо одному блокчейн-адресу нельзя достоверно назвать человека. Ищите выход на биржу или другой сервис с KYC, источник первого пополнения, адрес оплаты комиссий, повторный сбор средств и связанные кошельки. Для установления ФИО нужен официальный ответ сервиса либо иное процессуально закреплённое доказательство. В отчёте разделяйте: «установлено», «вероятная связь» и «не установлено».`;
  }

  if (/бирж|exchange|kyc/.test(query)) {
    return `${addressLine}\n\nОткройте «Биржи» и проверьте адрес по локальной базе меток. Если совпадения нет, проследите исходящие ветки дальше: депозитный адрес часто переводит средства на общий горячий кошелёк биржи. Совпадение с биржей — это основание для проверки и официального запроса, но не доказательство личности владельца без ответа биржи.`;
  }

  if (/миксер|смешив|tornado/.test(query)) {
    return "Миксер объединяет или перераспределяет средства, затрудняя прямое сопоставление входа и выхода. Подтверждением является контакт с известным адресом миксера или надёжная внешняя метка. Похожие суммы, быстрые переводы и дробление — только структурные признаки; проект не должен называть их доказательством сами по себе.";
  }

  if (/hop|хоп|переход/.test(query)) {
    return "Hop — один переход средств между кошельками. Hop 1: исходный адрес → первый получатель. Hop 2: первый получатель → следующий адрес. Каждый следующий hop увеличивает неопределённость, если на промежуточном кошельке смешались чужие средства.";
  }

  if (/стейбл|usdt|usdc/.test(query)) {
    return "Стейблкоин — криптотокен, цена которого обычно привязана к валюте, например USDT или USDC к доллару США. Это не банковский доллар: перевод проходит в блокчейне, а эмитент и биржи могут хранить дополнительные сведения о клиентах.";
  }

  if (/доказ|суд|винов|отч[её]т/.test(query)) {
    return "Для доказательной части сохраняйте полный адрес, хеш транзакции, сеть, сумму, токен, UTC-время, источник данных и дату выгрузки. Отдельно указывайте факты блокчейна, аналитические гипотезы и сведения, которые пока не подтверждены. Автоматический риск-балл и похожее поведение не доказывают вину без дополнительных материалов.";
  }

  if (/429|failed to fetch|ошиб|не загруж/.test(query)) {
    return "Сначала убедитесь, что одновременно запущены API (`npm run api`) и сайт (`npm run dev`). HTTP 429 означает лимит публичного провайдера: подождите и повторите запрос, не нажимая кнопку много раз. Failed to fetch обычно означает, что API на порту 8787 не запущен или недоступен.";
  }

  if (/куда|дальше|цепоч|маршрут|перев[её]л/.test(query)) {
    return `${addressLine}\n\nОткройте «Транзакции», выберите исходящие операции и нажимайте адрес в колонке «Куда». Для автоматического анализа используйте «Трассировку»: задайте период, сумму и по возможности хеш первоначального перевода. Проверяйте все ветки, точки повторного сбора и известные сервисы выхода.`;
  }

  return `${summary.pageGuide}\n\n${addressLine}\n\nЯ могу объяснить любой термин или подсказать следующий шаг. Например, спросите: «куда пошли деньги», «как проверить биржу», «что означает risk 99», «как оформить доказательства» или «почему возникла ошибка 429».`;
}

async function getOllamaStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    const models = (payload.models || []).map((item) => String(item.name || item.model || "")).filter(Boolean);
    const exactModel = models.find((item) => item === ollamaModel);
    const selectedModel = exactModel || models[0] || "";

    return {
      available: Boolean(selectedModel),
      connected: true,
      configuredModel: ollamaModel,
      model: selectedModel,
      models,
      mode: selectedModel ? "ollama" : "builtin",
    };
  } catch {
    return {
      available: false,
      connected: false,
      configuredModel: ollamaModel,
      model: "",
      models: [],
      mode: "builtin",
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAssistantMessages(items = []) {
  return items
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .slice(-10)
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").slice(0, 4_000),
    }))
    .filter((item) => item.content.trim());
}

async function askOllama(question, history, context, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs);
  const summary = assistantContextSummary(context);
  const systemPrompt = [
    "Ты — помощник следователя внутри ChainSentra. Отвечай по-русски, простыми словами и короткими шагами.",
    "Используй только переданный контекст. Никогда не выдумывай владельца кошелька, биржу, факт преступления или доказательство.",
    "Всегда различай: факт блокчейна, вероятная аналитическая связь и то, что пока не установлено.",
    "Риск-балл и паттерны не являются доказательством вины. Для установления личности объясняй необходимость официального запроса и внешних доказательств.",
    `Контекст страницы: ${JSON.stringify(summary)}`,
  ].join("\n");

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...normalizeAssistantMessages(history),
          { role: "user", content: question },
        ],
        stream: false,
        think: false,
        keep_alive: "10m",
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    const reply = String(payload.message?.content || "").trim();
    if (!reply) throw new Error("Ollama returned an empty response");
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

const apiV2 = createApiV2({
  dataDir,
  analyzeTransactions: async (address, items) => analyzeTransactions(address, items, await readEntityLabels()),
  providerConfig: {
    routescanBaseUrl: `${serviceProtocol}://${routescanHost}`,
    etherscanBaseUrl: `${serviceProtocol}://${etherscanApiHost}`,
    etherscanApiKey: providerCredential("ETHERSCAN_API_KEY"),
    tronBaseUrl: `${serviceProtocol}://${trongridHost}`,
    mempoolBaseUrl: mempoolApiBase,
    blockstreamBaseUrl: blockstreamApiBase,
    blockscout: Object.fromEntries(
      Object.entries(blockscoutHosts).map(([key, host]) => [
        key,
        (process.env[`BLOCKSCOUT_${key}_URL`] || `${blockscoutProtocol}://${host}`).replace(/\/$/, ""),
      ])
    ),
    binplorer: {
      apiKey: providerCredential("BINPLORER_API_KEY") || "freekey",
      endpoints: {
        BNB: (process.env.BINPLORER_BNB_URL || "https://api.binplorer.com").replace(/\/$/, ""),
      },
    },
  },
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `${requestBaseProtocol}://${request.headers.host}`);
    response.corsOrigin = requestCorsOrigin(request);

    if (request.headers.origin && !response.corsOrigin) {
      send(response, 403, { error: "Origin is not allowed" });
      return;
    }

    if (request.method === "OPTIONS") {
      send(response, 204, {});
      return;
    }

    if (url.pathname.startsWith("/api/v2/")) {
      await apiV2.handle({
        request,
        response,
        url,
        authenticate: requireAuthenticatedUser,
        readBody,
        send,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      send(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readBody(request);
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");

      if (!consumeAuthRateLimit(request, response, "register", username, registerRateLimit)) return;

      if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
        send(response, 400, { error: "Login must be 3-40 chars: a-z, 0-9, dot, underscore or dash." });
        return;
      }

      if (password.length < 8) {
        send(response, 400, { error: "Password must be at least 8 characters." });
        return;
      }

      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      const user = await mutateStore(usersFile, async (users) => {
        // A first local user can bootstrap the system. Subsequent self-registration
        // must be explicitly enabled by the system owner.
        if (users.length > 0 && !registrationEnabled) {
          throw requestError(403, "Registration is closed. Ask an administrator to create an account.");
        }
        if (users.some((item) => item.username === username)) {
          throw requestError(409, "Login already exists.");
        }
        const nextUser = {
          id: userIdFromUsername(username),
          username,
          displayName: String(body.displayName || username).trim() || username,
          passwordHash,
          role: users.length === 0 ? "admin" : "analyst",
          sessionVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
        return { items: [nextUser, ...users], result: nextUser };
      });
      send(response, 200, { user: safeUser(user), token: createAuthToken(user) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(request);
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      if (!consumeAuthRateLimit(request, response, "login", username, loginRateLimit)) return;
      const users = await readJson(usersFile);
      const user = users.find((item) => item.username === username);

      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        send(response, 401, { error: "Invalid login or password." });
        return;
      }

      send(response, 200, { user: safeUser(user), token: createAuthToken(user) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      const user = await requireAuthenticatedUser(request, response);

      if (!user) {
        return;
      }

      send(response, 200, { user: safeUser(user) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      await mutateStore(usersFile, async (users) => ({
        items: users.map((item) => item.id === user.id
          ? { ...item, sessionVersion: Number(item.sessionVersion || 0) + 1, updatedAt: new Date().toISOString() }
          : item),
        result: null,
      }));
      send(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/providers") {
      send(response, 200, await providerCapabilities());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/assistant/status") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const status = await getOllamaStatus();
      send(response, 200, {
        ...status,
        localOnly: true,
        setupCommand: `ollama run ${ollamaModel}`,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/assistant/chat") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const body = await readBody(request);
      const question = String(body.message || "").trim().slice(0, 4_000);

      if (!question) {
        send(response, 400, { error: "message is required" });
        return;
      }

      const status = await getOllamaStatus();

      if (status.available && status.model) {
        try {
          const reply = await askOllama(question, body.history || [], body.context || {}, status.model);
          send(response, 200, {
            reply,
            provider: "ollama",
            mode: "ai",
            model: status.model,
            localOnly: true,
          });
          return;
        } catch (error) {
          logger.info("local assistant fallback", { message: error.message });
        }
      }

      send(response, 200, {
        reply: builtInAssistantReply(question, body.context || {}),
        provider: "builtin",
        mode: "guide",
        model: "ChainSentra guide",
        localOnly: true,
        setupCommand: `ollama run ${ollamaModel}`,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wallets") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const profileId = user.id;
      const profiles = (await readProfiles()).filter((profile) => belongsToProfile(profile, profileId));
      send(response, 200, profiles);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/watchlist") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const profileId = user.id;
      const rules = (await readJson(watchlistRulesFile)).filter((rule) => belongsToProfile(rule, profileId));
      send(response, 200, rules);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/watchlist") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const rule = await readBody(request);

      if (!rule.address) {
        send(response, 400, { error: "address is required" });
        return;
      }

      const now = new Date().toISOString();
      const profileId = user.id;
      const rules = await readJson(watchlistRulesFile);
      const collidingRule = rule.id ? rules.find((item) => item.id === rule.id) : null;
      if (collidingRule && !belongsToProfile(collidingRule, profileId)) {
        send(response, 403, { error: "You cannot modify another user's watchlist rule" });
        return;
      }
      const existing = collidingRule || null;
      const nextRule = {
        ...existing,
        ...rule,
        profileId,
        id: existing?.id || rule.id || makeId("watch"),
        active: rule.active ?? existing?.active ?? true,
        createdAt: existing?.createdAt || rule.createdAt || now,
        updatedAt: now,
      };
      const nextRules = [
        nextRule,
        ...rules.filter((item) => !(item.id === nextRule.id && belongsToProfile(item, profileId))),
      ];

      await writeJson(watchlistRulesFile, nextRules);
      await appendAuditEvent({
        actor: user,
        action: existing ? "watchlist.update" : "watchlist.create",
        entityType: "watchlist_rule",
        entityId: nextRule.id,
        before: existing,
        after: nextRule,
      });
      await invalidateWalletRiskCache();
      send(response, 200, nextRule);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/watchlist/")) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const id = idFromUrl(url, "/api/watchlist/");
      const rules = await readJson(watchlistRulesFile);
      const deletedRule = rules.find((item) => item.id === id && belongsToProfile(item, user.id)) || null;

      await writeJson(watchlistRulesFile, rules.filter((item) => !(item.id === id && belongsToProfile(item, user.id))));
      if (deletedRule) {
        await appendAuditEvent({
          actor: user,
          action: "watchlist.delete",
          entityType: "watchlist_rule",
          entityId: id,
          before: deletedRule,
        });
      }
      await invalidateWalletRiskCache();
      send(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const profileId = user.id;
      const events = (await readJson(alertEventsFile)).filter((event) => belongsToProfile(event, profileId));
      send(response, 200, events);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/audit") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const allAuditEvents = await readJson(auditEventsFile);
      const events = allAuditEvents
        .filter((event) => event.actorId === user.id)
        .slice(0, limit);
      const verification = verifyAuditChain(allAuditEvents);
      send(response, 200, {
        items: events,
        count: events.length,
        integrity: "sha256_hash_chain",
        verification,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/watchlist/poll") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      if (polling) {
        send(response, 409, { error: "Watchlist polling is already running" });
        return;
      }
      polling = true;
      let result;
      try {
        result = await pollWatchlist({ profileId: user.id });
      } finally {
        polling = false;
      }
      send(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/entities") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const labels = await readEntityLabels();
      send(response, 200, labels);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/address-attribution") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const body = await readBody(request);
      const rawAddresses = Array.isArray(body.addresses)
        ? body.addresses
        : String(body.addresses || body.address || "").split(/[\s,;]+/);
      const addresses = uniqueValues(rawAddresses.map((value) => String(value || "").trim())).slice(0, 201);

      if (!addresses.length) {
        send(response, 400, { error: "at least one address is required" });
        return;
      }

      if (addresses.length > 200) {
        send(response, 400, { error: "maximum 200 addresses per request" });
        return;
      }

      const requestedNetwork = String(body.networkKey || "AUTO").trim().toUpperCase() || "AUTO";
      const labels = await readEntityLabels();
      const localResults = addresses.map((address) => {
        const detectedNetwork = detectAttributionNetwork(address);
        const exactMatches = labels.filter((label) => String(label.address || "").toLowerCase() === address.toLowerCase());
        const labelNetwork = exactMatches.find((label) => !["ALL", "UNKNOWN"].includes(label.networkKey || "UNKNOWN"))?.networkKey;
        const networkKey = requestedNetwork === "AUTO" ? (detectedNetwork === "UNKNOWN" ? labelNetwork || "UNKNOWN" : detectedNetwork) : requestedNetwork;
        const matches = exactMatches
          .filter((label) => requestedNetwork === "AUTO" || ["ALL", "UNKNOWN", networkKey].includes(label.networkKey || "UNKNOWN"))
          .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
          .slice(0, 5)
          .map(attributionMatch);
        const entity = matches[0] || null;
        const validFormat = detectedNetwork !== "UNKNOWN" || Boolean(entity);
        const isExchange = entity?.serviceType === "exchange";

        return {
          address,
          networkKey,
          detectedNetwork,
          validFormat,
          identified: Boolean(entity),
          isExchange,
          status: !validFormat
            ? "invalid_format"
            : isExchange
              ? "exchange"
              : entity
                ? "identified_non_exchange"
                : "not_identified",
          entity,
          matches,
        };
      });
      const publicLookupLimit = Math.max(1, Math.min(50, Number(process.env.PUBLIC_ATTRIBUTION_LOOKUP_LIMIT || 20)));
      const results = await Promise.all(localResults.map(async (localResult, index) => {
        if (!localResult.validFormat || index >= publicLookupLimit) {
          return {
            ...localResult,
            publicProviders: [],
            attributionWarnings: index >= publicLookupLimit ? ["Лимит публичной проверки достигнут; использована только локальная база."] : [],
          };
        }

        const publicResult = await lookupPublicAttribution({
          address: localResult.address,
          networkKey: localResult.networkKey,
          blockscoutBaseUrl: blockscoutBaseUrl(localResult.networkKey),
          tronscanApiBaseUrl,
          tronscanExplorerBaseUrl: `${publicWebProtocol}://${tronscanHost}`,
          tronscanApiKey: providerCredential("TRONSCAN_API_KEY"),
        });
        const combinedMatches = [...localResult.matches, ...publicResult.matches.map(attributionMatch)]
          .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
          .filter((match, matchIndex, items) => items.findIndex((item) => `${item.name}:${item.source}`.toLowerCase() === `${match.name}:${match.source}`.toLowerCase()) === matchIndex)
          .slice(0, 8);
        const entity = combinedMatches[0] || null;
        const isExchange = entity?.serviceType === "exchange";

        return {
          ...localResult,
          identified: Boolean(entity),
          isExchange,
          status: isExchange ? "exchange" : entity ? "identified_non_exchange" : "not_identified",
          entity,
          matches: combinedMatches,
          publicProviders: publicResult.providers,
          attributionWarnings: publicResult.errors,
        };
      }));
      const identified = results.filter((item) => item.identified).length;
      const exchanges = results.filter((item) => item.isExchange).length;

      send(response, 200, {
        generatedAt: new Date().toISOString(),
        provider: "Local entity labels + free public provider labels",
        providerStatus: uniqueValues(results.flatMap((item) => item.publicProviders || []).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)),
        summary: {
          total: results.length,
          identified,
          exchanges,
          otherKnown: identified - exchanges,
          unknown: results.filter((item) => item.status === "not_identified").length,
          invalid: results.filter((item) => item.status === "invalid_format").length,
        },
        results,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/entities/ofac") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      if (!requireAdmin(user, response)) return;
      const body = await readBody(request);
      const result = await importOfacEntityLabels(body);
      await appendAuditEvent({
        actor: user,
        action: "labels.import_ofac",
        entityType: "label_database",
        after: result,
        metadata: { files: Array.isArray(body.files) ? body.files : [] },
      });
      await invalidateDerivedAnalysisCache();
      send(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/entities/import-csv") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      if (!requireAdmin(user, response)) return;
      const body = await readBody(request);
      const result = await importEntityLabelsFromCsv(body.csv || body.text || "");
      await appendAuditEvent({
        actor: user,
        action: "labels.import_csv",
        entityType: "label_database",
        after: result,
      });
      await invalidateDerivedAnalysisCache();
      send(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/entities") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      if (!requireAdmin(user, response)) return;
      const body = await readBody(request);
      const now = new Date().toISOString();
      const address = normalizeSupportedAddress(body.address);

      if (!address) {
        send(response, 400, { error: "A valid EVM, TRON or Bitcoin address is required" });
        return;
      }

      const nextLabel = {
        id: body.id || makeId("entity"),
        address,
        networkKey: String(body.networkKey || "UNKNOWN").trim() || "UNKNOWN",
        category: String(body.category || "mixer").trim() || "mixer",
        name: String(body.name || "Known entity").trim() || "Known entity",
        confidence: Math.min(100, Math.max(1, Number(body.confidence || 80))),
        source: String(body.source || "manual").trim() || "manual",
        notes: String(body.notes || "").trim(),
        updatedAt: now,
        createdAt: body.createdAt || now,
      };

      if (isDemoDataRecord(nextLabel)) {
        send(response, 400, { error: "Demo, mock, fixture and synthetic labels are disabled." });
        return;
      }
      const existingLabel = await mutateStore(entityLabelsFile, async (labels) => {
        const activeLabels = labels.filter((label) => !isDemoDataRecord(label));
        const existing = activeLabels.find(
          (label) =>
            label.id === nextLabel.id ||
            (label.address?.toLowerCase() === nextLabel.address.toLowerCase() && label.networkKey === nextLabel.networkKey)
        ) || null;
        const nextLabels = [
          nextLabel,
          ...activeLabels.filter(
            (label) =>
              label.id !== nextLabel.id &&
              !(label.address?.toLowerCase() === nextLabel.address.toLowerCase() && label.networkKey === nextLabel.networkKey)
          ),
        ];
        return { items: nextLabels, result: existing };
      });
      await appendAuditEvent({
        actor: user,
        action: existingLabel ? "label.update" : "label.create",
        entityType: "entity_label",
        entityId: nextLabel.id,
        before: existingLabel,
        after: nextLabel,
        reason: body.reason || body.notes || "",
      });
      await invalidateDerivedAnalysisCache();
      send(response, 200, nextLabel);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/entities/")) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      if (!requireAdmin(user, response)) return;
      const id = idFromUrl(url, "/api/entities/");
      const { deletedLabel, deleted } = await mutateStore(entityLabelsFile, async (labels) => {
        const activeLabels = labels.filter((label) => !isDemoDataRecord(label));
        const deletedLabel = activeLabels.find((label) => label.id === id) || null;
        const nextLabels = activeLabels.filter((label) => label.id !== id);
        return {
          items: nextLabels,
          result: { deletedLabel, deleted: activeLabels.length - nextLabels.length },
        };
      });
      if (deletedLabel) {
        await appendAuditEvent({
          actor: user,
          action: "label.delete",
          entityType: "entity_label",
          entityId: id,
          before: deletedLabel,
        });
      }
      await invalidateDerivedAnalysisCache();
      send(response, 200, { ok: true, deleted });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/cases") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const profileId = user.id;
      const cases = (await readJson(investigationCasesFile)).filter((item) => belongsToProfile(item, profileId));
      send(response, 200, cases);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/cases") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const body = await readBody(request);
      const now = new Date().toISOString();
      const rootAddress = String(body.rootAddress || "").trim();
      const profileId = user.id;

      if (!rootAddress) {
        send(response, 400, { error: "rootAddress is required" });
        return;
      }

      const { nextCase, existingCase } = await mutateStore(investigationCasesFile, async (cases) => {
        const collidingCase = body.id ? cases.find((item) => item.id === body.id) : null;
        if (collidingCase && !belongsToProfile(collidingCase, profileId)) {
          throw requestError(403, "You cannot modify another user's investigation case");
        }
        const existingCase = collidingCase || null;
        const nextCase = {
          id: body.id || makeId("case"),
          profileId,
          title: String(body.title || `Investigation ${rootAddress.slice(0, 10)}`).trim(),
          rootAddress,
          networkKey: String(body.networkKey || "UNKNOWN").trim(),
          severity: String(body.severity || "Medium").trim(),
          status: String(body.status || "open").trim(),
          summary: body.summary || {},
          graphState: body.graphState || {},
          notes: String(body.notes || "").trim(),
          subjects: Array.isArray(body.subjects) ? body.subjects.slice(0, 200) : (existingCase?.subjects || []),
          victims: Array.isArray(body.victims) ? body.victims.slice(0, 500) : (existingCase?.victims || []),
          loss: body.loss || existingCase?.loss || null,
          evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 500) : (existingCase?.evidence || []),
          traceReport: body.traceReport || existingCase?.traceReport || null,
          updatedAt: now,
          createdAt: body.createdAt || existingCase?.createdAt || now,
        };
        return {
          items: [nextCase, ...cases.filter((item) => !(item.id === nextCase.id && belongsToProfile(item, profileId)))],
          result: { nextCase, existingCase },
        };
      });
      await appendAuditEvent({
        actor: user,
        action: existingCase ? "case.update" : "case.create",
        entityType: "investigation_case",
        entityId: nextCase.id,
        before: existingCase,
        after: nextCase,
        reason: body.changeReason || "",
      });
      await invalidateDerivedAnalysisCache();
      send(response, 200, nextCase);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/cases/")) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const id = idFromUrl(url, "/api/cases/");
      const deletedCase = await mutateStore(investigationCasesFile, async (cases) => {
        const deletedCase = cases.find((item) => item.id === id && belongsToProfile(item, user.id)) || null;
        return {
          items: cases.filter((item) => !(item.id === id && belongsToProfile(item, user.id))),
          result: deletedCase,
        };
      });
      if (deletedCase) {
        await appendAuditEvent({
          actor: user,
          action: "case.delete",
          entityType: "investigation_case",
          entityId: id,
          before: deletedCase,
        });
      }
      await invalidateDerivedAnalysisCache();
      send(response, 200, { ok: true, deleted: deletedCase ? 1 : 0 });
      return;
    }

    const protectedWalletAnalysisSuffixes = [
      "/risk",
      "/tokens",
      "/nfts",
      "/graph",
      "/graph-neighbors",
      "/mixer-chain-scans/latest",
      "/mixer-chain-scans",
      "/mixer-chain-scan",
      "/transactions",
      "/fund-trace",
      "/arkham",
      "/live",
    ];
    const isProtectedWalletAnalysis =
      request.method === "GET" &&
      url.pathname.startsWith("/api/wallets/") &&
      protectedWalletAnalysisSuffixes.some((suffix) => url.pathname.endsWith(suffix));

    if (isProtectedWalletAnalysis) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      request.authenticatedUser = user;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/risk")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/risk".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const mode = url.searchParams.get("mode") === "fast" ? "fast" : "full";
      const refresh = url.searchParams.get("refresh") === "true";
      const cached = refresh ? null : await readCachedWalletRisk({ address, networkKey, mode });

      if (cached) {
        send(response, 200, cached);
        return;
      }

      const risk = await buildWalletRisk({ address, networkKey, mode });
      await writeCachedWalletRisk({ address, networkKey, mode, payload: risk });

      send(response, 200, risk);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/tokens")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/tokens".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
      const refresh = url.searchParams.get("refresh") === "true";

      if (!isEvmAddress(address)) {
        send(response, 200, {
          address,
          networkKey,
          tokens: [],
          provider: "Alchemy Token API",
          providerRequired: true,
          message: "Alchemy token balances are available for EVM addresses only.",
        });
        return;
      }

      const cacheKey = `tokens:${normalizeCacheAddress(address)}:${networkKey}:${limit}`;
      const balances = await withApiResponseCache({
        cacheKey,
        ttlMs: tokenBalanceCacheTtlMs,
        refresh,
        load: async () => {
          try {
            return networkKey === "ALL"
              ? await getAggregatedAlchemyTokenBalances({ address, limit })
              : await getAlchemyTokenBalances({ address, networkKey, limit });
          } catch (error) {
            const network = getEvmNetworkByKey(networkKey);
            return {
              address,
              networkKey: network.key,
              networkName: network.name,
              tokens: [],
              totalTokenCount: 0,
              nonZeroTokenCount: 0,
              hasMore: false,
              provider: "Alchemy Token API",
              providerRequired: true,
              errors: [error.message],
              message:
                error.status === 403
                  ? `Alchemy rejected ${network.name} token balances with HTTP 403. Enable this network in Alchemy or use another provider for ${network.name}.`
                  : `Alchemy token balances failed: ${error.message}`,
            };
          }
        },
      });
      send(response, 200, balances);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/nfts")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/nfts".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 24)));
      const refresh = url.searchParams.get("refresh") === "true";

      if (!isEvmAddress(address)) {
        send(response, 200, {
          address,
          networkKey,
          nfts: [],
          provider: "Alchemy NFT API",
          providerRequired: true,
          message: "NFT exposure is available for EVM addresses only.",
        });
        return;
      }

      const cacheKey = `nfts:${normalizeCacheAddress(address)}:${networkKey}:${limit}`;
      const nftExposure = await withApiResponseCache({
        cacheKey,
        ttlMs: nftExposureCacheTtlMs,
        refresh,
        load: async () => {
          try {
            return networkKey === "ALL"
              ? await getAggregatedAlchemyNftsForOwner({ address, limit })
              : await getAlchemyNftsForOwner({ address, networkKey, limit });
          } catch (error) {
            const network = getEvmNetworkByKey(networkKey);
            return {
              address,
              networkKey: network.key,
              networkName: network.name,
              nfts: [],
              totalCount: 0,
              shownCount: 0,
              spamCount: 0,
              hasMore: false,
              provider: "Alchemy NFT API",
              providerRequired: true,
              errors: [error.message],
              message: `Alchemy NFT exposure failed: ${error.message}`,
            };
          }
        },
      });
      send(response, 200, nftExposure);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/graph")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/graph".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const depth = Math.min(12, Math.max(1, Number(url.searchParams.get("depth") || 4)));
      const maxNodes = Math.min(250, Math.max(10, Number(url.searchParams.get("maxNodes") || 80)));
      const perAddressLimit = Math.min(25, Math.max(3, Number(url.searchParams.get("perAddressLimit") || 10)));
      const startAt = url.searchParams.get("startAt") || "";
      const endAt = url.searchParams.get("endAt") || "";
      const requestedFlowDirection = url.searchParams.get("flowDirection") || "outgoing";
      const flowDirection = ["outgoing", "incoming", "all"].includes(requestedFlowDirection) ? requestedFlowDirection : "outgoing";
      const refresh = url.searchParams.get("refresh") === "true";

      if ((startAt && !Number.isFinite(Date.parse(startAt))) || (endAt && !Number.isFinite(Date.parse(endAt)))) {
        send(response, 400, { error: "Invalid graph period" });
        return;
      }
      if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
        send(response, 400, { error: "Graph period end must be later than start" });
        return;
      }

      const graph = await withApiResponseCache({
        cacheKey: `graph:${normalizeCacheAddress(address)}:${networkKey}:${depth}:${maxNodes}:${perAddressLimit}:${Date.parse(startAt) || 0}:${Date.parse(endAt) || 0}:${flowDirection}`,
        ttlMs: graphCacheTtlMs,
        refresh,
        load: () => buildWalletGraph({
          address,
          networkKey,
          depth,
          maxNodes,
          perAddressLimit,
          startAt,
          endAt,
          flowDirection,
        }),
      });

      send(response, 200, graph);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/graph-neighbors")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/graph-neighbors".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const perAddressLimit = Math.min(25, Math.max(3, Number(url.searchParams.get("perAddressLimit") || 10)));
      const maxNodes = Math.min(80, Math.max(10, Number(url.searchParams.get("maxNodes") || perAddressLimit * 2 + 1)));
      const startAt = url.searchParams.get("startAt") || "";
      const endAt = url.searchParams.get("endAt") || "";
      const requestedFlowDirection = url.searchParams.get("flowDirection") || "outgoing";
      const flowDirection = ["outgoing", "incoming", "all"].includes(requestedFlowDirection) ? requestedFlowDirection : "outgoing";
      const refresh = url.searchParams.get("refresh") === "true";
      const graph = await withApiResponseCache({
        cacheKey: `graph-neighbors:${normalizeCacheAddress(address)}:${networkKey}:${maxNodes}:${perAddressLimit}:${Date.parse(startAt) || 0}:${Date.parse(endAt) || 0}:${flowDirection}`,
        ttlMs: graphCacheTtlMs,
        refresh,
        load: () => buildWalletGraph({
          address,
          networkKey,
          depth: 0,
          maxNodes,
          perAddressLimit,
          startAt,
          endAt,
          flowDirection,
        }),
      });

      send(response, 200, {
        ...graph,
        mode: "neighbors",
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/mixer-chain-scans/latest")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/mixer-chain-scans/latest".length));
      const networkKey = url.searchParams.get("networkKey") || "";
      const user = request.authenticatedUser;
      const profileId = user.id;
      const reports = await listMixerChainScanReports({ address, networkKey, profileId, limit: 1 });
      const report = reports[0] || null;

      if (!report) {
        send(response, 404, { error: "No mixer chain scan report found" });
        return;
      }

      send(response, 200, report);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/mixer-chain-scans")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/mixer-chain-scans".length));
      const networkKey = url.searchParams.get("networkKey") || "";
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 10)));
      const user = request.authenticatedUser;
      const profileId = user.id;
      const reports = await listMixerChainScanReports({ address, networkKey, profileId, limit });

      send(response, 200, reports.map(mixerChainScanReportSummary));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/mixer-chain-scan")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/mixer-chain-scan".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const depth = Math.min(4, Math.max(0, Number(url.searchParams.get("depth") || 2)));
      const maxPerHop = Math.min(8, Math.max(1, Number(url.searchParams.get("maxPerHop") || 4)));
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 80)));
      const refresh = url.searchParams.get("refresh") === "true";
      const saveEntities = url.searchParams.get("saveEntities") !== "false";
      const persist = url.searchParams.get("persist") !== "false";
      const user = request.authenticatedUser;
      const profileId = user.id;
      const result = await buildMixerChainScan({
        address,
        networkKey,
        depth,
        maxPerHop,
        limit,
        refresh,
        saveEntities,
      });
      const report = persist
        ? await saveMixerChainScanReport({
            result,
            profileId,
            params: { networkKey, depth, maxPerHop, limit, refresh, saveEntities },
          })
        : null;

      if (report?.id && result.analysis?.chainScan) {
        result.analysis.chainScan.reportId = report.id;
        result.analysis.chainScan.reportSavedAt = report.createdAt;
      }

      send(response, 200, {
        ...result,
        report: mixerChainScanReportSummary(report),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/transactions")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/transactions".length));
      const networkKey = url.searchParams.get("networkKey") || (isTronAddress(address) ? "TRX" : isBitcoinAddress(address) ? "BTC" : "ETH");
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 25)));
      const fingerprint = url.searchParams.get("fingerprint") || "";
      const includeDust = url.searchParams.get("includeDust") === "true";
      const minAmountSun = Math.max(1, Number(url.searchParams.get("minAmountSun") || tronDustMinSun));
      const refresh = url.searchParams.get("refresh") === "true";
      const entityLabels = await readEntityLabels();

      if (networkKey === "TRX" || /^T[A-Za-z0-9]{25,40}$/.test(address)) {
        const transactions = await getTransactionsWithCache({
          address,
          networkKey: "TRX",
          page,
          limit,
          fingerprint,
          includeDust,
          minAmountSun,
          refresh,
        });
        send(response, 200, {
          address,
          networkKey: "TRX",
          analysis: analyzeTransactions(address, transactions.items, entityLabels),
          ...transactions,
          dataQuality: transactionDataQuality(transactions),
        });
        return;
      }

      if (networkKey === "BTC" || isBitcoinAddress(address)) {
        const transactions = await getTransactionsWithCache({
          address,
          networkKey: "BTC",
          page,
          limit,
          fingerprint,
          refresh,
        });
        send(response, 200, {
          address,
          networkKey: "BTC",
          analysis: analyzeTransactions(address, transactions.items, entityLabels),
          ...transactions,
          dataQuality: transactionDataQuality(transactions),
        });
        return;
      }

      if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
        const transactions = await getTransactionsWithCache({
          address,
          networkKey,
          page,
          limit,
          refresh,
        });
        send(response, 200, {
          address,
          networkKey,
          analysis: analyzeTransactions(address, transactions.items, entityLabels),
          ...transactions,
          dataQuality: transactionDataQuality(transactions),
        });
        return;
      }

      send(response, 200, {
        address,
        networkKey,
        items: [],
        analysis: analyzeTransactions(address, [], entityLabels),
        hasMore: false,
        providerRequired: true,
        message: "Transaction history provider is not configured for this network yet.",
        dataQuality: transactionDataQuality({
          items: [],
          hasMore: false,
          providerRequired: true,
          message: "Transaction history provider is not configured for this network yet.",
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/fund-trace")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/fund-trace".length));
      const networkKey = url.searchParams.get("networkKey") || "TRX";

      if (networkKey !== "TRX" || !isTronAddress(address)) {
        send(response, 400, { error: "Первый режим трассировки поддерживает адреса сети TRON." });
        return;
      }

      const result = await traceTronFunds({
        address,
        tokenSymbol: url.searchParams.get("tokenSymbol") || "USDT",
        startAt: url.searchParams.get("startAt") || "",
        endAt: url.searchParams.get("endAt") || "",
        seedTxHash: url.searchParams.get("seedTxHash") || "",
        amount: url.searchParams.get("amount") || "",
        depth: url.searchParams.get("depth") || 3,
        hopWindowHours: url.searchParams.get("hopWindowHours") || 72,
        maxBranches: url.searchParams.get("maxBranches") || 8,
        maxSeeds: url.searchParams.get("maxSeeds") || 20,
      });
      send(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/arkham")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/arkham".length));
      const refresh = url.searchParams.get("refresh") === "true";
      const intelligence = await withApiResponseCache({
        cacheKey: `arkham:${normalizeCacheAddress(address)}`,
        ttlMs: arkhamCacheTtlMs,
        refresh,
        load: () => getArkhamAddressIntelligence(address),
      });

      send(response, 200, intelligence);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/live")) {
      const prefix = "/api/wallets/";
      const address = decodeURIComponent(url.pathname.slice(prefix.length, -"/live".length));
      const refresh = url.searchParams.get("refresh") === "true";
      const liveProfile = await withApiResponseCache({
        cacheKey: `live:${normalizeCacheAddress(address)}`,
        ttlMs: liveProfileCacheTtlMs,
        refresh,
        load: async () => {
          if (isTronAddress(address)) {
            return getTronLiveProfile(address);
          }

          if (isBitcoinAddress(address)) {
            return getBitcoinLiveProfile(address);
          }

          if (isEvmAddress(address)) {
            return getEvmLiveProfile(address);
          }

          return null;
        },
      });

      if (!liveProfile) {
        send(response, 400, { error: "Live profile supports EVM, TRON and Bitcoin addresses." });
        return;
      }

      send(response, 200, liveProfile);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/wallets/")) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const address = profileIdFromUrl(url);
      const profileId = user.id;
      const profiles = await readProfiles();
      const profile = profiles.find((item) => item.address === address && belongsToProfile(item, profileId));

      if (!profile) {
        send(response, 404, { error: "Wallet profile not found" });
        return;
      }

      send(response, 200, profile);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wallets") {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const profile = await readBody(request);
      const address = normalizeSupportedAddress(profile.address);

      if (!address) {
        send(response, 400, { error: "A valid EVM, TRON or Bitcoin address is required" });
        return;
      }

      const now = new Date().toISOString();
      const profileId = user.id;
      const { nextProfile, existing } = await mutateStore(walletProfilesFile, async (rawProfiles) => {
        const profiles = rawProfiles.map((item) => normalizeScopedItem(item, item.profileId));
        const existing = profiles.find((item) => item.address === address && belongsToProfile(item, profileId));
        const nextProfile = normalizeWalletProfile({
          ...existing,
          ...profile,
          address,
          profileId,
          createdAt: existing?.createdAt || profile.createdAt || now,
          updatedAt: now,
        }, profileId);
        return {
          items: [nextProfile, ...profiles.filter((item) => !(item.address === address && belongsToProfile(item, profileId)))],
          result: { nextProfile, existing },
        };
      });
      await appendAuditEvent({
        actor: user,
        action: existing ? "wallet_profile.update" : "wallet_profile.create",
        entityType: "wallet_profile",
        entityId: nextProfile.address,
        before: existing,
        after: nextProfile,
      });
      send(response, 200, nextProfile);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/wallets/")) {
      const user = await requireAuthenticatedUser(request, response);
      if (!user) return;
      const address = profileIdFromUrl(url);
      const profileId = user.id;
      const profiles = await readProfiles();
      const deletedProfile = profiles.find((item) => item.address === address && belongsToProfile(item, profileId)) || null;
      const nextProfiles = profiles.filter((item) => !(item.address === address && belongsToProfile(item, profileId)));

      await writeProfiles(nextProfiles);
      if (deletedProfile) {
        await appendAuditEvent({
          actor: user,
          action: "wallet_profile.delete",
          entityType: "wallet_profile",
          entityId: address,
          before: deletedProfile,
        });
      }
      send(response, 200, { ok: true });
      return;
    }

    send(response, 404, { error: "Not found" });
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }

    const statusCode = Number(error.statusCode || 500);
    if (statusCode >= 500) {
      logger.error("Unhandled API error", error);
      send(response, 500, { error: "Internal server error" });
      return;
    }
    send(response, statusCode, { error: error.message || "Request failed" });
  }
});

await ensureStore();

const pollTimer = setInterval(pollWatchlistSafely, pollIntervalMs);

server.listen(port, host, () => {
  logger.info(`ChainSentra API listening on http://${host}:${port}`);
  logger.info(`Watchlist polling interval: ${pollIntervalMs}ms`);
});

function gracefulShutdown() {
  clearInterval(pollTimer);
  server.close(async () => {
    if (pool) {
      await pool.end();
    }
    process.exit(0);
  });
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
