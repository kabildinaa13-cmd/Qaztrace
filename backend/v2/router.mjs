import { TransactionService } from "./services/transaction-service.mjs";
import { toLegacyTransaction } from "./domain/transaction.mjs";

function pathAddress(pathname) {
  const match = pathname.match(/^\/api\/v2\/addresses\/([^/]+)\/transactions$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function booleanParam(value) {
  return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

export function createApiV2(options) {
  const service = new TransactionService(options);

  return {
    service,
    async handle({ request, response, url, authenticate, readBody, send }) {
      if (!url.pathname.startsWith("/api/v2/")) return false;

      if (request.method === "GET" && url.pathname === "/api/v2/health") {
        send(response, 200, { ok: true, apiVersion: "2.0", normalizedTransactionSchema: "2.0" });
        return true;
      }

      if (request.method === "GET" && url.pathname === "/api/v2/networks") {
        send(response, 200, { schemaVersion: "2.0", items: service.networks() });
        return true;
      }

      const user = await authenticate(request, response);
      if (!user) return true;

      if (request.method === "POST" && url.pathname === "/api/v2/networks/detect") {
        const body = await readBody(request);
        const address = String(body.address || "").trim();
        if (!address) {
          send(response, 400, { error: "address is required" });
          return true;
        }
        send(response, 200, await service.detectAddress({ address, probe: Boolean(body.probe) }));
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/v2/address-connections") {
        const body = await readBody(request);
        const result = await service.analyzeAddressConnections({
          addresses: body.addresses,
          networkKey: body.networkKey,
          depth: body.depth,
          limitPerAddress: body.limitPerAddress,
          from: body.from || null,
          to: body.to || null,
        });
        send(response, 200, result);
        return true;
      }

      const address = request.method === "GET" ? pathAddress(url.pathname) : null;
      if (address !== null) {
        const networkKey = url.searchParams.get("network") || url.searchParams.get("networkKey") || "";
        const result = await service.listTransactions({
          address,
          networkKey,
          page: url.searchParams.get("page") || 1,
          limit: url.searchParams.get("limit") || 25,
          cursor: url.searchParams.get("cursor") || "",
          from: url.searchParams.get("from") || null,
          to: url.searchParams.get("to") || null,
          refresh: booleanParam(url.searchParams.get("refresh")),
        });
        const legacyItems = result.items.map(toLegacyTransaction);
        const analysis = options.analyzeTransactions
          ? await options.analyzeTransactions(address, legacyItems)
          : null;
        send(response, 200, { ...result, analysis });
        return true;
      }

      send(response, 404, { error: "API v2 route not found" });
      return true;
    },
  };
}
