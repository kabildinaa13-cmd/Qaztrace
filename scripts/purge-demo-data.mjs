import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const dataDir = join(projectDir, "backend", "data");
const protectedFiles = [
  "wallet_profiles.json",
  "watchlist_rules.json",
  "alert_events.json",
  "entity_labels.json",
  "investigation_cases.json",
  "mixer_chain_scans.json",
];

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

const removedByFile = {};
const summary = {};

for (const filename of protectedFiles) {
  const path = join(dataDir, filename);
  let items = [];

  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    summary[filename] = { before: 0, removed: 0, after: 0 };
    continue;
  }

  const removed = items.filter(isDemoDataRecord);
  const kept = items.filter((item) => !isDemoDataRecord(item));
  removedByFile[filename] = removed;
  summary[filename] = { before: items.length, removed: removed.length, after: kept.length };

  if (removed.length) {
    await writeFile(path, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
  }
}

const removedCount = Object.values(removedByFile).reduce((sum, items) => sum + items.length, 0);

if (removedCount) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = resolve(projectDir, "..", "..", "backups", `demo-data-purge-${timestamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, "removed-records.json"), `${JSON.stringify(removedByFile, null, 2)}\n`, "utf8");
  await writeFile(join(backupDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Removed ${removedCount} explicitly marked demo records. Backup: ${backupDir}`);
} else {
  console.log("No explicitly marked demo records found.");
}

console.log(JSON.stringify(summary, null, 2));
