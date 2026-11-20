export class ProviderHttpError extends Error {
  constructor(message, { provider, status = null, retryable = false } = {}) {
    super(message);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

export async function fetchJson(url, { provider, fetchImpl = fetch, timeoutMs = 20_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderHttpError(`${provider} HTTP ${response.status}`, {
        provider,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderHttpError(`${provider} request timed out`, { provider, retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonWithRetry(url, options = {}) {
  const attempts = Math.max(1, Math.min(6, Number(options.attempts || 3)));
  const baseDelayMs = Math.max(100, Number(options.baseDelayMs || 750));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
