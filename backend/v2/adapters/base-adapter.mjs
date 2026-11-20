export class NetworkAdapter {
  constructor({ network, rawStore, fetchImpl = fetch }) {
    this.network = network;
    this.rawStore = rawStore;
    this.fetchImpl = fetchImpl;
  }

  validateAddress() {
    throw new Error("validateAddress() is not implemented");
  }

  async listTransactions() {
    throw new Error("listTransactions() is not implemented");
  }

  capabilities() {
    return {
      validate: true,
      detect: true,
      balance: false,
      assets: false,
      transactions: true,
      transaction: false,
      decode: false,
      counterparties: true,
      normalize: true,
    };
  }

  async archive({ provider, operation, request, response }) {
    return this.rawStore.save({
      provider,
      operation,
      networkKey: this.network.key,
      request,
      response,
    });
  }
}

export function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return {};
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    const error = new Error("Invalid pagination cursor");
    error.statusCode = 400;
    throw error;
  }
}
