import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, "backend", "data");
const externalDir = join(dataDir, "external");
const labelsFile = join(dataDir, "entity_labels.json");

const poisonHunterGroundtruthFile = join(externalDir, "phishing_address_groundtruth.txt");
const poisonHunterDetectedFile = join(externalDir, "phishing_address_we_detected_TP.txt");
const etherscanBenignFile = join(externalDir, "benign_addresses_on_etherscan.txt");

const fbiDprkTraderTraitorAddresses = [
  "3LU8wRu4ZnXP4UM8Yo6kkTiGHM9BubgyiG",
  "39idqitN9tYNmq3wYanwg3MitFB5TZCjWu",
  "3AAUBbKJorvNhEUFhKnep9YTwmZECxE4Nk",
  "3PjNaSeP8GzLjGeu51JR19Q2Lu8W2Te9oc",
  "3NbdrezMzAVVfXv5MTQJn4hWqKhYCTCJoB",
  "34VXKa5upLWVYMXmgid6bFM4BaQXHxSUoL",
];

function normalizeKey(networkKey, address) {
  return `${String(networkKey || "UNKNOWN").toUpperCase()}:${String(address || "").toLowerCase()}`;
}

function entityId(prefix, networkKey, address) {
  const cleaned = String(address || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (cleaned.length >= 18 && cleaned.length <= 64) {
    return `${prefix}_${cleaned.slice(0, 48)}`;
  }

  const digest = createHash("sha256").update(`${networkKey}:${address}`).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function uniqueId(baseId, existingIds) {
  let nextId = baseId;
  let suffix = 2;

  while (existingIds.has(nextId)) {
    nextId = `${baseId}_${suffix}`;
    suffix += 1;
  }

  existingIds.add(nextId);
  return nextId;
}

async function readAddressFile(path) {
  const text = await readFile(path, "utf8");

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.split(/[\s,;]+/)[0])
    .filter(Boolean);
}

function setField(item, field, value) {
  if (item[field] === value) {
    return false;
  }

  item[field] = value;
  return true;
}

function upsertLabel({ labels, byKey, existingIds, address, networkKey, category, name, confidence, source, notes }) {
  const now = new Date().toISOString();
  const key = normalizeKey(networkKey, address);
  const existing = byKey.get(key);

  if (existing) {
    let changed = false;
    changed = setField(existing, "category", category) || changed;
    changed = setField(existing, "name", name) || changed;
    changed = setField(existing, "confidence", Math.max(Number(existing.confidence || 0), Number(confidence || 0))) || changed;
    changed = setField(existing, "source", source) || changed;
    changed = setField(existing, "notes", notes) || changed;

    if (changed) {
      existing.updatedAt = now;
    }

    return changed ? "updated" : "unchanged";
  }

  const id = uniqueId(entityId(category === "benign" ? "entity_benign" : "entity", networkKey, address), existingIds);
  const item = {
    id,
    address,
    networkKey,
    category,
    name,
    confidence,
    source,
    notes,
    createdAt: now,
    updatedAt: now,
  };

  labels.push(item);
  byKey.set(key, item);
  return "added";
}

function sortLabels(labels) {
  labels.sort((a, b) => {
    const aKey = [
      String(a.category || ""),
      String(a.source || ""),
      String(a.networkKey || ""),
      String(a.address || "").toLowerCase(),
    ].join("\u0000");
    const bKey = [
      String(b.category || ""),
      String(b.source || ""),
      String(b.networkKey || ""),
      String(b.address || "").toLowerCase(),
    ].join("\u0000");

    return aKey.localeCompare(bKey);
  });
}

function bump(stats, status) {
  stats[status] = (stats[status] || 0) + 1;
}

const labels = JSON.parse(await readFile(labelsFile, "utf8"));
const byKey = new Map(labels.map((item) => [normalizeKey(item.networkKey, item.address), item]));
const existingIds = new Set(labels.map((item) => item.id).filter(Boolean));
const stats = { added: 0, updated: 0, unchanged: 0 };

const phishingGroundtruth = new Set((await readAddressFile(poisonHunterGroundtruthFile)).map((address) => address.toLowerCase()));
const phishingDetected = new Set((await readAddressFile(poisonHunterDetectedFile)).map((address) => address.toLowerCase()));
const etherscanBenign = await readAddressFile(etherscanBenignFile);

for (const address of [...phishingGroundtruth].sort()) {
  const detected = phishingDetected.has(address);
  const status = upsertLabel({
    labels,
    byKey,
    existingIds,
    address,
    networkKey: "ETH",
    category: "scam",
    name: "Poison-Hunter address poisoning phishing address",
    confidence: detected ? 94 : 92,
    source: "poison-hunter:ccs24",
    notes: `Poison-Hunter dataset. groundtruth=true; detected_tp=${detected}. Labeled by Etherscan and Forta; Poison-Hunter detected subset tracked separately.`,
  });
  bump(stats, status);
}

for (const address of etherscanBenign) {
  const existing = byKey.get(normalizeKey("ETH", address));

  if (existing && String(existing.category || "").toLowerCase() !== "benign") {
    bump(stats, "unchanged");
    continue;
  }

  const status = upsertLabel({
    labels,
    byKey,
    existingIds,
    address,
    networkKey: "ETH",
    category: "benign",
    name: "Etherscan popular benign address",
    confidence: 88,
    source: "etherscan:benign_labels:poison-hunter",
    notes: "Poison-Hunter benign_addresses_on_etherscan.txt. Popular Ethereum address assigned a benign label on Etherscan; low-risk reference label, not a scam indicator.",
  });
  bump(stats, status);
}

for (const address of fbiDprkTraderTraitorAddresses) {
  const status = upsertLabel({
    labels,
    byKey,
    existingIds,
    address,
    networkKey: "BTC",
    category: "scam",
    name: "FBI DPRK TraderTraitor stolen funds address",
    confidence: 96,
    source: "fbi-dprk-tradertraitor:2023-08-22",
    notes: "FBI press release, 2023-08-22: BTC addresses holding cryptocurrency funds stolen by DPRK TraderTraitor-affiliated actors.",
  });
  bump(stats, status);
}

sortLabels(labels);
await writeFile(labelsFile, `${JSON.stringify(labels, null, 2)}\n`, "utf8");

const sourceCounts = labels.reduce((counts, item) => {
  const source = item.source || "manual";
  counts[source] = (counts[source] || 0) + 1;
  return counts;
}, {});

const categoryCounts = labels.reduce((counts, item) => {
  const category = item.category || "unknown";
  counts[category] = (counts[category] || 0) + 1;
  return counts;
}, {});

console.log(JSON.stringify({
  ...stats,
  total: labels.length,
  categories: categoryCounts,
  sources: sourceCounts,
  files: {
    poisonHunterGroundtruth: phishingGroundtruth.size,
    poisonHunterDetected: phishingDetected.size,
    etherscanBenign: etherscanBenign.length,
    fbiDprkTraderTraitor: fbiDprkTraderTraitorAddresses.length,
  },
}, null, 2));
