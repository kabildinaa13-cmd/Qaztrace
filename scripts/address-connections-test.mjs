import assert from "node:assert/strict";
import { analyzeAddressConnections } from "../backend/v2/services/address-connection-service.mjs";

const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";
const C = "0x0000000000000000000000000000000000000003";
const X = "0x0000000000000000000000000000000000000010";
const Y = "0x0000000000000000000000000000000000000020";

function transaction(hash, from, to) {
  return {
    id: `ETH:${hash}`,
    txHash: hash,
    network: { key: "ETH", family: "evm" },
    fromAddresses: [from],
    toAddresses: [to],
    amount: { raw: "1000000", value: "1", decimals: 6, symbol: "USDT", contractAddress: "0xtoken" },
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance: { provider: "test-live-provider" },
  };
}

const transactionsByAddress = new Map([
  [A, [transaction("a-x", A, X), transaction("a-b", A, B), transaction("b-a", B, A)]],
  [B, [transaction("b-x", B, X), transaction("a-b", A, B), transaction("b-a", B, A)]],
  [C, []],
  [X, [transaction("a-x", A, X), transaction("b-x", B, X), transaction("x-y", X, Y)]],
  [Y, [transaction("x-y", X, Y)]],
]);

const result = await analyzeAddressConnections({
  addresses: [A, B, C],
  network: { key: "ETH", name: "Ethereum", family: "evm" },
  depth: 2,
  limitPerAddress: 50,
  loadTransactions: async ({ address }) => ({
    items: transactionsByAddress.get(address.toLowerCase()) || [],
    pagination: { hasMore: false },
    dataQuality: { sourceProviders: ["test-live-provider"], errors: [], warnings: [] },
  }),
});

assert.equal(result.summary.inputAddressCount, 3);
assert.equal(result.summary.directTransferCount, 2);
assert.equal(result.summary.mutualPairCount, 1);
assert.equal(result.commonRecipients.find((item) => item.address === X)?.inputCount, 2);
assert.equal(result.commonRecipients.find((item) => item.address === X)?.transfers?.[0]?.totalValue, "1");
assert.equal(result.convergencePoints.find((item) => item.address === X)?.inputCount, 2);
assert.equal(result.convergencePoints.find((item) => item.address === Y)?.inputCount, 2);
assert.ok(result.pathsBetweenInputs.some((item) => item.from === A && item.to === B));
assert.ok(result.pathsBetweenInputs.some((item) => item.from === B && item.to === A));
assert.ok(result.graph.edges.some((edge) => edge.from === X && edge.to === Y));
assert.deepEqual(result.dataQuality.sourceProviders, ["test-live-provider"]);

console.log("Address connection analysis test passed.");
