const MAX_INPUT_ADDRESSES = 25;
const MAX_DEPTH = 3;
const MAX_EXPANDED_ADDRESSES = 45;

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function addressKey(address, family) {
  const clean = String(address || "").trim();
  return family === "evm" ? clean.toLowerCase() : clean;
}

function txAddresses(tx, field, family) {
  return unique((Array.isArray(tx?.[field]) ? tx[field] : []).map((address) => addressKey(address, family)));
}

function txIdentity(tx) {
  return String(tx?.txHash || tx?.id || "").trim();
}

function formatRawAmount(rawValue, decimalsValue) {
  const decimals = Math.max(0, Number(decimalsValue || 0));
  let raw;
  try {
    raw = BigInt(String(rawValue || "0"));
  } catch {
    return String(rawValue || "0");
  }
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  if (!decimals) return `${negative ? "-" : ""}${absolute}`;
  const padded = absolute.toString().padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

function addTransaction(graph, tx, family, networkKey) {
  const fromAddresses = txAddresses(tx, "fromAddresses", family);
  const toAddresses = txAddresses(tx, "toAddresses", family);
  const txHash = txIdentity(tx);
  if (!txHash || !fromAddresses.length || !toAddresses.length) return;

  const symbol = String(tx?.amount?.symbol || "UNKNOWN").trim() || "UNKNOWN";
  const contractAddress = String(tx?.amount?.contractAddress || "").trim();
  const assetKey = contractAddress || symbol;
  for (const from of fromAddresses) {
    for (const to of toAddresses) {
      if (!from || !to || from === to) continue;
      const observationId = `${networkKey}:${txHash}:${from}:${to}:${assetKey}`;
      if (graph.observationIds.has(observationId)) continue;
      graph.observationIds.add(observationId);
      graph.nodes.add(from);
      graph.nodes.add(to);
      graph.observations.push({
        id: observationId,
        txHash,
        from,
        to,
        networkKey,
        symbol,
        contractAddress: contractAddress || null,
        decimals: Math.max(0, Number(tx?.amount?.decimals || 0)),
        raw: String(tx?.amount?.raw || "0"),
        value: String(tx?.amount?.value || "0"),
        timestamp: tx?.timestamp || null,
        explorerUrl: tx?.explorerUrl || null,
        provider: tx?.provenance?.provider || null,
      });
    }
  }
}

function aggregateEdges(observations) {
  const groups = new Map();
  for (const item of observations) {
    const key = `${item.from}|${item.to}|${item.networkKey}|${item.contractAddress || item.symbol}`;
    const group = groups.get(key) || {
      id: key,
      from: item.from,
      to: item.to,
      networkKey: item.networkKey,
      symbol: item.symbol,
      contractAddress: item.contractAddress,
      decimals: item.decimals,
      totalRaw: "0",
      totalValue: "0",
      transactionCount: 0,
      txHashes: [],
      examples: [],
      firstSeen: null,
      lastSeen: null,
    };
    group.transactionCount += 1;
    try {
      group.totalRaw = (BigInt(group.totalRaw) + BigInt(item.raw || "0")).toString();
      group.totalValue = formatRawAmount(group.totalRaw, group.decimals);
    } catch {
      group.totalValue = group.examples[0]?.value || item.value || "0";
    }
    if (!group.txHashes.includes(item.txHash)) group.txHashes.push(item.txHash);
    if (group.examples.length < 5) {
      group.examples.push({
        txHash: item.txHash,
        value: item.value,
        raw: item.raw,
        timestamp: item.timestamp,
        explorerUrl: item.explorerUrl,
      });
    }
    if (item.timestamp && (!group.firstSeen || item.timestamp < group.firstSeen)) group.firstSeen = item.timestamp;
    if (item.timestamp && (!group.lastSeen || item.timestamp > group.lastSeen)) group.lastSeen = item.timestamp;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.transactionCount - a.transactionCount);
}

function adjacency(edges, direction = "out") {
  const result = new Map();
  for (const edge of edges) {
    const key = direction === "out" ? edge.from : edge.to;
    const value = direction === "out" ? edge.to : edge.from;
    if (!result.has(key)) result.set(key, new Set());
    result.get(key).add(value);
  }
  return result;
}

function originReachability(seedKeys, edges, depth) {
  const out = adjacency(edges, "out");
  const origins = new Map(seedKeys.map((seed) => [seed, new Set([seed])]));
  const hops = new Map(seedKeys.map((seed) => [seed, 0]));

  for (let hop = 1; hop <= depth; hop += 1) {
    let changed = false;
    for (const [from, targets] of out.entries()) {
      const sourceOrigins = origins.get(from);
      if (!sourceOrigins?.size || (hops.get(from) ?? Infinity) >= hop) continue;
      for (const target of targets) {
        const targetOrigins = origins.get(target) || new Set();
        const before = targetOrigins.size;
        for (const origin of sourceOrigins) targetOrigins.add(origin);
        if (targetOrigins.size > before) {
          origins.set(target, targetOrigins);
          hops.set(target, Math.min(hops.get(target) ?? Infinity, hop));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { origins, hops };
}

function shortestPath(start, target, out, maxDepth) {
  const queue = [[start]];
  const seen = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const current = path[path.length - 1];
    if (path.length - 1 >= maxDepth) continue;
    for (const next of out.get(current) || []) {
      const nextPath = [...path, next];
      if (next === target) return nextPath;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(nextPath);
      }
    }
  }
  return null;
}

function connectedSeedGroups(seedKeys, edges) {
  const undirected = new Map();
  const add = (from, to) => {
    if (!undirected.has(from)) undirected.set(from, new Set());
    undirected.get(from).add(to);
  };
  for (const edge of edges) {
    add(edge.from, edge.to);
    add(edge.to, edge.from);
  }
  const seedSet = new Set(seedKeys);
  const visited = new Set();
  const groups = [];
  for (const seed of seedKeys) {
    if (visited.has(seed)) continue;
    const queue = [seed];
    const nodes = [];
    const seeds = [];
    visited.add(seed);
    while (queue.length) {
      const current = queue.shift();
      nodes.push(current);
      if (seedSet.has(current)) seeds.push(current);
      for (const next of undirected.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    if (seeds.length >= 2) groups.push({ seeds, nodeCount: nodes.length, nodes: nodes.slice(0, 100) });
  }
  return groups.sort((a, b) => b.seeds.length - a.seeds.length || b.nodeCount - a.nodeCount);
}

function collectDirectPatterns(seedKeys, edges) {
  const seedSet = new Set(seedKeys);
  const recipients = new Map();
  const senders = new Map();
  const directTransfers = [];
  for (const edge of edges) {
    if (seedSet.has(edge.from) && seedSet.has(edge.to)) directTransfers.push(edge);
    if (seedSet.has(edge.from)) {
      if (!recipients.has(edge.to)) recipients.set(edge.to, new Set());
      recipients.get(edge.to).add(edge.from);
    }
    if (seedSet.has(edge.to)) {
      if (!senders.has(edge.from)) senders.set(edge.from, new Set());
      senders.get(edge.from).add(edge.to);
    }
  }
  const describe = (map, role) => [...map.entries()]
    .filter(([, seeds]) => seeds.size >= 2)
    .map(([address, seeds]) => ({
      address,
      inputAddresses: [...seeds],
      inputCount: seeds.size,
      role,
      transfers: edges.filter((edge) => role === "common_recipient"
        ? seeds.has(edge.from) && edge.to === address
        : edge.from === address && seeds.has(edge.to)),
    }))
    .sort((a, b) => b.inputCount - a.inputCount);
  const directedPairs = new Set(directTransfers.map((edge) => `${edge.from}|${edge.to}`));
  const mutual = [];
  const mutualSeen = new Set();
  for (const edge of directTransfers) {
    if (!directedPairs.has(`${edge.to}|${edge.from}`)) continue;
    const key = [edge.from, edge.to].sort().join("|");
    if (!mutualSeen.has(key)) {
      mutualSeen.add(key);
      mutual.push({ addresses: [edge.from, edge.to] });
    }
  }
  return {
    directTransfers,
    commonRecipients: describe(recipients, "common_recipient"),
    commonSenders: describe(senders, "common_sender"),
    mutualTransfers: mutual,
  };
}

function prioritizeExpansion(seedKeys, edges, scanned, origins) {
  const seedSet = new Set(seedKeys);
  const score = new Map();
  for (const edge of edges) {
    if (!scanned.has(edge.to) && !seedSet.has(edge.to)) {
      score.set(edge.to, (score.get(edge.to) || 0) + 4 + (origins.get(edge.to)?.size || 0) * 20);
    }
    if (!scanned.has(edge.from) && !seedSet.has(edge.from)) {
      score.set(edge.from, (score.get(edge.from) || 0) + 1);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([address]) => address);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function analyzeAddressConnections({
  addresses,
  network,
  depth = 2,
  limitPerAddress = 50,
  from = null,
  to = null,
  loadTransactions,
}) {
  const family = network.family;
  const originalByKey = new Map();
  for (const value of Array.isArray(addresses) ? addresses : []) {
    const original = String(value || "").trim();
    const key = addressKey(original, family);
    if (key && !originalByKey.has(key)) originalByKey.set(key, original);
  }
  const seedKeys = [...originalByKey.keys()];
  if (seedKeys.length < 2) {
    const error = new Error("Для поиска связей укажите минимум два разных адреса.");
    error.statusCode = 400;
    throw error;
  }
  if (seedKeys.length > MAX_INPUT_ADDRESSES) {
    const error = new Error(`За один запуск можно проверить не более ${MAX_INPUT_ADDRESSES} адресов.`);
    error.statusCode = 400;
    throw error;
  }

  const safeDepth = clamp(depth, 1, MAX_DEPTH, 2);
  const safeLimit = clamp(limitPerAddress, 10, 100, 50);
  const graph = { nodes: new Set(seedKeys), observations: [], observationIds: new Set() };
  const scanned = new Set();
  const addressChecks = [];
  const providers = new Set();
  const errors = [];
  const warnings = [];
  const concurrency = family === "tron" ? 2 : 4;

  const scan = async (batch, hop) => {
    const uniqueBatch = unique(batch).filter((address) => !scanned.has(address));
    for (const address of uniqueBatch) scanned.add(address);
    const results = await mapWithConcurrency(uniqueBatch, concurrency, async (address) => {
      try {
        const result = await loadTransactions({
          address: originalByKey.get(address) || address,
          limit: safeLimit,
          from,
          to,
        });
        return { address, result };
      } catch (error) {
        return { address, error };
      }
    });
    for (const item of results) {
      if (item.error) {
        const message = `${item.address}: ${item.error.message || "источник не ответил"}`;
        errors.push(message);
        addressChecks.push({ address: item.address, hop, status: "error", transactionCount: null, error: item.error.message });
        continue;
      }
      const result = item.result;
      for (const provider of result.dataQuality?.sourceProviders || []) providers.add(provider);
      errors.push(...(result.dataQuality?.errors || []).map((message) => `${item.address}: ${message}`));
      warnings.push(...(result.dataQuality?.warnings || []));
      for (const tx of result.items || []) addTransaction(graph, tx, family, network.key);
      addressChecks.push({
        address: item.address,
        hop,
        status: result.dataQuality?.errors?.length ? "partial" : "checked",
        transactionCount: result.items?.length || 0,
        hasMore: Boolean(result.pagination?.hasMore),
      });
    }
  };

  await scan(seedKeys, 0);
  for (let hop = 1; hop < safeDepth && scanned.size < MAX_EXPANDED_ADDRESSES; hop += 1) {
    const currentEdges = aggregateEdges(graph.observations);
    const reachability = originReachability(seedKeys, currentEdges, safeDepth);
    const remaining = MAX_EXPANDED_ADDRESSES - scanned.size;
    const perLayer = Math.min(family === "tron" ? 5 : family === "utxo" ? 10 : 12, remaining);
    const candidates = prioritizeExpansion(seedKeys, currentEdges, scanned, reachability.origins).slice(0, perLayer);
    if (!candidates.length) break;
    await scan(candidates, hop);
  }

  const edges = aggregateEdges(graph.observations);
  const direct = collectDirectPatterns(seedKeys, edges);
  const reachability = originReachability(seedKeys, edges, safeDepth);
  const out = adjacency(edges, "out");
  const incoming = adjacency(edges, "in");
  const seedSet = new Set(seedKeys);
  const convergencePoints = [...reachability.origins.entries()]
    .filter(([address, origins]) => !seedSet.has(address) && origins.size >= 2)
    .map(([address, origins]) => ({
      address,
      inputAddresses: [...origins],
      inputCount: origins.size,
      firstHop: reachability.hops.get(address) ?? null,
      incomingAddressCount: incoming.get(address)?.size || 0,
      status: "confirmed_on_chain_structure",
    }))
    .sort((a, b) => b.inputCount - a.inputCount || a.firstHop - b.firstHop);

  const pathsBetweenInputs = [];
  for (const start of seedKeys) {
    for (const target of seedKeys) {
      if (start === target) continue;
      const path = shortestPath(start, target, out, safeDepth);
      if (path) pathsBetweenInputs.push({ from: start, to: target, hops: path.length - 1, path });
    }
  }

  const observedEndpoints = [...reachability.origins.entries()]
    .filter(([address]) => !seedSet.has(address) && !(out.get(address)?.size))
    .map(([address, origins]) => ({
      address,
      inputAddresses: [...origins],
      inputCount: origins.size,
      incomingAddressCount: incoming.get(address)?.size || 0,
      status: "observed_end_of_loaded_graph",
    }))
    .sort((a, b) => b.inputCount - a.inputCount || b.incomingAddressCount - a.incomingAddressCount)
    .slice(0, 50);

  const nodeItems = [...graph.nodes].map((address) => {
    const originCount = reachability.origins.get(address)?.size || 0;
    const isInput = seedSet.has(address);
    const isConvergence = convergencePoints.some((item) => item.address === address);
    return {
      id: address,
      address: originalByKey.get(address) || address,
      key: address,
      isInput,
      role: isInput ? "input" : isConvergence ? "convergence" : !(out.get(address)?.size) ? "observed_endpoint" : "counterparty",
      originCount,
      inDegree: incoming.get(address)?.size || 0,
      outDegree: out.get(address)?.size || 0,
      firstHop: reachability.hops.get(address) ?? null,
    };
  });

  const facts = [
    ...direct.directTransfers.map((edge) => ({ type: "direct_transfer", status: "on_chain_fact", title: "Прямой перевод между введёнными адресами", addresses: [edge.from, edge.to], txHashes: edge.txHashes, transactionCount: edge.transactionCount, transfers: [edge] })),
    ...direct.mutualTransfers.map((item) => ({ type: "mutual_transfer", status: "on_chain_fact", title: "Адреса переводили средства друг другу", addresses: item.addresses, transfers: edges.filter((edge) => item.addresses.includes(edge.from) && item.addresses.includes(edge.to)) })),
    ...direct.commonRecipients.map((item) => ({ type: "common_recipient", status: "on_chain_fact", title: "Несколько введённых адресов переводили на один адрес", addresses: [...item.inputAddresses, item.address], targetAddress: item.address, inputCount: item.inputCount, transfers: item.transfers })),
    ...direct.commonSenders.map((item) => ({ type: "common_sender", status: "on_chain_fact", title: "Один адрес переводил нескольким введённым адресам", addresses: [item.address, ...item.inputAddresses], sourceAddress: item.address, inputCount: item.inputCount, transfers: item.transfers })),
    ...convergencePoints.map((item) => ({ type: "convergence", status: "structural_connection", title: "Ветки переводов структурно сходятся на одном адресе", addresses: [...item.inputAddresses, item.address], targetAddress: item.address, inputCount: item.inputCount, hops: item.firstHop })),
  ];

  return {
    schemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    network,
    request: { addresses: seedKeys.map((key) => originalByKey.get(key) || key), depth: safeDepth, limitPerAddress: safeLimit, from, to },
    summary: {
      inputAddressCount: seedKeys.length,
      checkedAddressCount: addressChecks.filter((item) => item.status !== "error").length,
      failedAddressCount: addressChecks.filter((item) => item.status === "error").length,
      transactionObservationCount: graph.observationIds.size,
      graphNodeCount: nodeItems.length,
      graphEdgeCount: edges.length,
      directTransferCount: direct.directTransfers.length,
      mutualPairCount: direct.mutualTransfers.length,
      commonRecipientCount: direct.commonRecipients.length,
      commonSenderCount: direct.commonSenders.length,
      convergenceCount: convergencePoints.length,
      connectedGroupCount: connectedSeedGroups(seedKeys, edges).length,
      pathBetweenInputCount: pathsBetweenInputs.length,
    },
    facts,
    directTransfers: direct.directTransfers,
    mutualTransfers: direct.mutualTransfers,
    commonRecipients: direct.commonRecipients,
    commonSenders: direct.commonSenders,
    convergencePoints,
    pathsBetweenInputs,
    connectedGroups: connectedSeedGroups(seedKeys, edges),
    observedEndpoints,
    graph: { nodes: nodeItems, edges },
    addressChecks,
    dataQuality: {
      dataMode: "live",
      sourceProviders: [...providers],
      completeness: errors.length || warnings.length || addressChecks.some((item) => item.hasMore) ? "partial" : "complete_for_loaded_pages",
      errors: unique(errors),
      warnings: unique([
        ...warnings,
        "Анализ охватывает только загруженную публичную историю и выбранный период.",
        "Общий получатель или цепочка переводов подтверждают движение средств, но сами по себе не доказывают общего владельца адресов.",
        ...(family === "utxo" ? ["Для Bitcoin несколько входов и выходов одной транзакции не означают автоматически одного владельца."] : []),
      ]),
    },
  };
}

export const ADDRESS_CONNECTION_LIMITS = {
  maxInputAddresses: MAX_INPUT_ADDRESSES,
  maxDepth: MAX_DEPTH,
  maxExpandedAddresses: MAX_EXPANDED_ADDRESSES,
};
