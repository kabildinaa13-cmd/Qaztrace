import assert from "node:assert/strict";
import {
  lookupPublicAttribution,
  parseBlockscoutAttribution,
  parseTronscanAttribution,
  publicLabelCategory,
} from "../backend/public-attribution.mjs";

const evmAddress = "0x28C6c06298d514Db089934071355E5743bf21d60";
const tronAddress = "TApXXKRdJqTRNhjcn8894Nci75zymcmBEr";

assert.equal(publicLabelCategory("Binance hot wallet"), "exchange");
assert.equal(publicLabelCategory("Uniswap Router"), "dex");

const blockscout = parseBlockscoutAttribution({
  address: evmAddress,
  networkKey: "ETH",
  baseUrl: "https://eth.blockscout.com",
  payload: { public_tags: [{ display_name: "Binance hot wallet", label: "CEX" }] },
});
assert.equal(blockscout[0].category, "exchange");
assert.equal(blockscout[0].evidenceLevel, "public_provider_label");

const tronscan = parseTronscanAttribution({
  address: tronAddress,
  payload: { publicTag: "Bybit", blueTag: "Bybit Exchange", publicTagDesc: "Public exchange label" },
});
assert.equal(tronscan[0].category, "exchange");
assert.equal(tronscan[0].networkKey, "TRX");

const calls = [];
const lookup = await lookupPublicAttribution({
  address: tronAddress,
  networkKey: "TRX",
  tronscanApiKey: "own-test-key",
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), key: options.headers["TRON-PRO-API-KEY"] });
    return { ok: true, status: 200, async json() { return { publicTag: "OKX" }; } };
  },
});
assert.equal(calls[0].key, "own-test-key");
assert.equal(lookup.matches[0].name, "OKX");
assert.equal(lookup.matches[0].category, "exchange");

const noKey = await lookupPublicAttribution({ address: tronAddress, networkKey: "TRX", fetchImpl: async () => { throw new Error("must not call"); } });
assert.equal(noKey.matches.length, 0);
assert.equal(noKey.providers[0].configured, false);

console.log("Public attribution tests passed");
