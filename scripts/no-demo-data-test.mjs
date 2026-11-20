import { readFile } from "node:fs/promises";
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

const sourceChecks = [
  ["backend/server.mjs", ["/api/alerts/test", "/api/entities/seed"]],
  ["src/App.jsx", ["Отправить тест", "Загрузить seed labels"]],
  ["src/services/alertApi.js", ["sendTestAlert"]],
  ["src/services/entityApi.js", ["importSeedEntityLabels"]],
];

const failures = [];

for (const [filename, forbidden] of sourceChecks) {
  const source = await readFile(join(projectDir, filename), "utf8");
  for (const token of forbidden) {
    if (source.includes(token)) failures.push(`${filename}: forbidden runtime token ${JSON.stringify(token)}`);
  }
}

const serverSource = await readFile(join(projectDir, "backend", "server.mjs"), "utf8");
if (!serverSource.includes("demoDataEnabled: false")) {
  failures.push("backend/server.mjs: the disabled demo-data policy is missing");
}

for (const filename of protectedFiles) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, filename), "utf8"));
    const records = Array.isArray(parsed) ? parsed : [];
    const demoCount = records.filter(isDemoDataRecord).length;
    if (demoCount) failures.push(`${filename}: ${demoCount} demo record(s) remain`);
  } catch (error) {
    failures.push(`${filename}: cannot validate JSON (${error.message})`);
  }
}

if (failures.length) {
  console.error("Demo-data policy check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Demo-data policy check passed: runtime generators are absent and protected stores contain no demo records.");
}
