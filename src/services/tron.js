const trongridProtocol = import.meta.env.VITE_TRONGRID_PROTOCOL || "https";
const trongridHost = import.meta.env.VITE_TRONGRID_HOST || "api.trongrid.io";
const TRONGRID_BASE = `${trongridProtocol}://${trongridHost}`;
const KNOWN_TRON_TOKENS = {
  TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj: { symbol: "USDT", name: "Tether USD", decimals: 6 },
  TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: { symbol: "TUSD", name: "TrueUSD", decimals: 18 },
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT: { symbol: "USDJ", name: "JUST Stablecoin", decimals: 18 },
};

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "TRON-PRO-API-KEY": apiKey } : {}),
  };
}

async function postJson(path, body, apiKey) {
  const response = await fetch(`${TRONGRID_BASE}${path}`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`TronGrid HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.Error) {
    throw new Error(payload.Error);
  }

  return payload;
}

async function getJson(path, apiKey) {
  const response = await fetch(`${TRONGRID_BASE}${path}`, {
    headers: headers(apiKey),
  });

  if (!response.ok) {
    throw new Error(`TronGrid HTTP ${response.status}`);
  }

  return response.json();
}

function formatTrx(sun = 0) {
  const value = Number(sun || 0) / 1_000_000;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  });
}

function shortTokenId(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function formatTokenBalance(rawValue, decimals = 6) {
  const raw = BigInt(String(rawValue || "0"));
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

function normalizeTronTokens(account = {}, accountDetails = {}) {
  const tokensByKey = new Map();
  const addToken = (token) => {
    const { key, symbol, name, rawBalance, decimals = 6, tokenType, contractAddress } = token;

    if (!rawBalance || String(rawBalance) === "0") {
      return;
    }

    const tokenKey = key || contractAddress || symbol;
    const known = KNOWN_TRON_TOKENS[contractAddress] || {};
    const nextDecimals = known.decimals ?? decimals;
    const nextSymbol = known.symbol || symbol || shortTokenId(tokenKey);

    tokensByKey.set(tokenKey, {
      key: tokenKey,
      symbol: nextSymbol,
      name: known.name || name || nextSymbol,
      balance: formatTokenBalance(rawBalance, nextDecimals),
      rawBalance: String(rawBalance),
      decimals: nextDecimals,
      tokenType,
      contractAddress,
    });
  };

  for (const item of account.trc20 || accountDetails.trc20 || []) {
    for (const [contractAddress, rawBalance] of Object.entries(item || {})) {
      addToken({
        key: contractAddress,
        symbol: KNOWN_TRON_TOKENS[contractAddress]?.symbol || shortTokenId(contractAddress),
        rawBalance,
        decimals: KNOWN_TRON_TOKENS[contractAddress]?.decimals || 6,
        tokenType: "TRC20",
        contractAddress,
      });
    }
  }

  for (const item of account.assetV2 || accountDetails.assetV2 || []) {
    addToken({
      key: item.key,
      symbol: item.key,
      name: `TRC10 ${item.key}`,
      rawBalance: item.value,
      decimals: 6,
      tokenType: "TRC10",
    });
  }

  for (const [assetId, rawBalance] of Object.entries(account.asset || accountDetails.asset || {})) {
    addToken({
      key: assetId,
      symbol: `TRC10 ${assetId}`,
      rawBalance,
      decimals: 6,
      tokenType: "TRC10",
    });
  }

  return [...tokensByKey.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function activityTimestamp(account) {
  return (
    account.latest_opration_time ||
    account.latest_consume_time ||
    account.latest_consume_free_time ||
    account.create_time ||
    null
  );
}

export async function analyzeTronAddress(apiKey, address) {
  const [account, accountDetails, transactions, block] = await Promise.all([
    postJson("/wallet/getaccount", { address, visible: true }, apiKey),
    getJson(`/v1/accounts/${encodeURIComponent(address)}`, apiKey).catch(() => ({ data: [] })),
    getJson(`/v1/accounts/${encodeURIComponent(address)}/transactions?limit=20&only_confirmed=true&order_by=block_timestamp,desc`, apiKey),
    postJson("/wallet/getnowblock", {}, apiKey),
  ]);

  const txCount = transactions.meta?.total ?? transactions.data?.length ?? 0;
  const latestBlock = block.block_header?.raw_data?.number ?? null;

  return {
    networkKey: "TRX",
    networkName: "TRON",
    symbol: "TRX",
    balance: formatTrx(account.balance),
    balanceSun: account.balance || 0,
    txCount,
    blockNumber: latestBlock,
    accountCreatedAt: account.create_time || null,
    latestActivityAt: activityTimestamp(account),
    latestTransactions: transactions.data || [],
    tokens: normalizeTronTokens(account, accountDetails.data?.[0] || {}),
    source: "TRON Developer / TronGrid API",
  };
}
