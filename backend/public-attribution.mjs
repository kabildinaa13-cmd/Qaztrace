const exchangePattern = /\b(?:binance|bybit|okx|okex|coinbase|kraken|kucoin|gate(?:\.io)?|mexc|htx|huobi|bitfinex|bitstamp|gemini|bitget|bingx|upbit|bithumb|whitebit|crypto\.com|poloniex|bitmart|coinex|cex)\b/i;
const mixerPattern = /\b(?:mixer|mixing|tornado\s*cash|coinjoin|privacy)\b/i;
const bridgePattern = /\b(?:bridge|wormhole|allbridge|multichain)\b/i;
const dexPattern = /\b(?:dex|uniswap|sushiswap|pancakeswap|sunswap|justswap)\b/i;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueTexts(values) {
  const seen = new Set();
  return values.map(cleanText).filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function publicLabelCategory(value) {
  const text = cleanText(value);
  if (exchangePattern.test(text)) return "exchange";
  if (mixerPattern.test(text)) return "mixer";
  if (bridgePattern.test(text)) return "bridge";
  if (dexPattern.test(text)) return "dex";
  return "service";
}

function evidenceLabel({ address, networkKey, name, source, confidence, notes, externalUrl }) {
  return {
    id: `public:${source}:${networkKey}:${address}:${name}`.toLowerCase(),
    address,
    networkKey,
    category: publicLabelCategory(name),
    name,
    confidence,
    source,
    notes,
    externalUrl,
    evidenceLevel: "public_provider_label",
    checkedAt: new Date().toISOString(),
  };
}

export function parseBlockscoutAttribution({ address, networkKey = "ETH", payload, baseUrl }) {
  if (!payload || typeof payload !== "object") return [];

  const publicTags = Array.isArray(payload.public_tags) ? payload.public_tags : [];
  const metadataTags = Array.isArray(payload.metadata?.tags) ? payload.metadata.tags : [];
  const tagTexts = uniqueTexts([
    ...publicTags.flatMap((tag) => [tag?.display_name, tag?.label]),
    ...metadataTags.flatMap((tag) => [tag?.name, tag?.label, tag?.display_name]),
  ]);
  const explicitName = cleanText(payload.name || payload.metadata?.name);
  const names = tagTexts.length
    ? tagTexts
    : explicitName && publicLabelCategory(explicitName) !== "service"
      ? [explicitName]
      : [];

  return names.map((name) => evidenceLabel({
    address,
    networkKey,
    name,
    source: `Blockscout public tag (${networkKey})`,
    confidence: publicLabelCategory(name) === "exchange" ? 82 : 72,
    notes: "Публичная метка обозревателя Blockscout. Она определяет сервис, но сама по себе не устанавливает владельца аккаунта.",
    externalUrl: `${String(baseUrl || "").replace(/\/$/, "")}/address/${address}`,
  }));
}

export function parseTronscanAttribution({ address, payload, explorerBaseUrl = "https://tronscan.org" }) {
  if (!payload || typeof payload !== "object") return [];

  const names = uniqueTexts([
    payload.publicTag,
    payload.addressTag,
    payload.blueTag,
    payload.greyTag,
    payload.name,
  ]).filter((name) => publicLabelCategory(name) !== "service" || cleanText(payload.publicTag) === name);

  return names.map((name) => evidenceLabel({
    address,
    networkKey: "TRX",
    name,
    source: "TRONSCAN public account label",
    confidence: publicLabelCategory(name) === "exchange" ? 88 : 76,
    notes: cleanText(payload.publicTagDesc) || "Публичная метка аккаунта TRONSCAN. Она определяет сервис, но сама по себе не устанавливает владельца аккаунта.",
    externalUrl: `${String(explorerBaseUrl || "https://tronscan.org").replace(/\/$/, "")}/#/address/${address}`,
  }));
}

async function fetchJson(url, { fetchImpl, headers = {}, timeoutMs = 12_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function lookupPublicAttribution({
  address,
  networkKey,
  fetchImpl = fetch,
  blockscoutBaseUrl = "",
  tronscanApiBaseUrl = "https://apilist.tronscanapi.com",
  tronscanExplorerBaseUrl = "https://tronscan.org",
  tronscanApiKey = "",
}) {
  const matches = [];
  const providers = [];
  const errors = [];

  if (networkKey === "ETH" && blockscoutBaseUrl) {
    const provider = "Blockscout public tags";
    try {
      const baseUrl = blockscoutBaseUrl.replace(/\/$/, "");
      const payload = await fetchJson(`${baseUrl}/api/v2/addresses/${encodeURIComponent(address)}`, { fetchImpl });
      matches.push(...parseBlockscoutAttribution({ address, networkKey, payload, baseUrl }));
      providers.push({ name: provider, configured: true, checked: true });
    } catch (error) {
      providers.push({ name: provider, configured: true, checked: false });
      errors.push(`${provider}: ${error.message}`);
    }
  }

  if (networkKey === "TRX") {
    const provider = "TRONSCAN account labels";
    if (!tronscanApiKey) {
      providers.push({
        name: provider,
        configured: false,
        checked: false,
        message: "Нужен собственный бесплатный TRONSCAN_API_KEY.",
      });
    } else {
      try {
        const baseUrl = tronscanApiBaseUrl.replace(/\/$/, "");
        const payload = await fetchJson(`${baseUrl}/api/accountv2?address=${encodeURIComponent(address)}`, {
          fetchImpl,
          headers: { "TRON-PRO-API-KEY": tronscanApiKey },
        });
        matches.push(...parseTronscanAttribution({ address, payload, explorerBaseUrl: tronscanExplorerBaseUrl }));
        providers.push({ name: provider, configured: true, checked: true });
      } catch (error) {
        providers.push({ name: provider, configured: true, checked: false });
        errors.push(`${provider}: ${error.message}`);
      }
    }
  }

  return { matches, providers, errors };
}
