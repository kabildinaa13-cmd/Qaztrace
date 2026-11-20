import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class RawResponseStore {
  constructor({ dataDir }) {
    this.directory = join(dataDir, "raw_provider_responses");
  }

  async save({ provider, operation, networkKey, request, response }) {
    const retrievedAt = new Date().toISOString();
    const canonical = canonicalJson(response);
    const contentHash = createHash("sha256").update(canonical).digest("hex");
    const id = `raw_${Date.now()}_${randomUUID()}`;
    const record = {
      id,
      provider,
      operation,
      networkKey,
      retrievedAt,
      contentHash,
      request,
      response,
    };
    await mkdir(this.directory, { recursive: true });
    const day = retrievedAt.slice(0, 10);
    await appendFile(join(this.directory, `${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    return { id, contentHash, retrievedAt };
  }
}
