import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionService } from "../backend/v2/services/transaction-service.mjs";
import { toLegacyTransaction } from "../backend/v2/domain/transaction.mjs";

const tronAddress = "TApXXKRdJqTRNhjcn8894Nci75zymcmBEr";
const bitcoinAddress = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const evmAddress = "0x0000000000000000000000000000000000000001";
const dataDir = await mkdtemp(join(tmpdir(), "chainsentinel-v2-"));

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

async function mockFetch(url) {
  const value = String(url);
  if (value.includes("api.binplorer.com/getAddressTransactions")) {
    return jsonResponse([{
      timestamp: 1_700_000_005,
      from: evmAddress,
      to: "0x0000000000000000000000000000000000000004",
      hash: "bnb-native-hash",
      rawValue: "500000000000000000",
      success: true,
    }]);
  }
  if (value.includes("api.binplorer.com/getAddressHistory")) {
    return jsonResponse({ operations: [{
      timestamp: 1_700_000_006,
      transactionHash: "bnb-token-hash",
      from: evmAddress,
      to: "0x0000000000000000000000000000000000000005",
      value: "7500000",
      tokenInfo: {
        address: "0x0000000000000000000000000000000000000006",
        decimals: "6",
        symbol: "USDT",
      },
    }] });
  }
  if (value.includes("trongrid") && value.includes("trc20")) {
    return jsonResponse({
      data: [{
        transaction_id: "tron-token-hash",
        from: tronAddress,
        to: "TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa",
        value: "1960000000",
        block_timestamp: 1_700_000_001_000,
        token_info: { address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", symbol: "USDT", decimals: 6 },
      }],
      meta: {},
    });
  }
  if (value.includes("trongrid")) {
    return jsonResponse({ data: [], meta: {} });
  }
  if (value.includes("mempool.space")) {
    return jsonResponse([{
      txid: "bitcoin-hash",
      fee: 500,
      status: { confirmed: true, block_height: 800000, block_time: 1_700_000_002 },
      vin: [{ txid: "previous-hash", vout: 0, prevout: { scriptpubkey_address: bitcoinAddress, value: 100000 } }],
      vout: [
        { scriptpubkey_address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", value: 60000 },
        { scriptpubkey_address: bitcoinAddress, value: 39500 },
      ],
    }]);
  }
  if (value.includes("action=tokentx")) {
    return jsonResponse({ status: "1", result: [{
      hash: "evm-token-hash",
      from: evmAddress,
      to: "0x0000000000000000000000000000000000000002",
      value: "2500000",
      tokenDecimal: "6",
      tokenSymbol: "USDT",
      contractAddress: "0x0000000000000000000000000000000000000003",
      blockNumber: "19000000",
      timeStamp: "1700000003",
    }] });
  }
  if (value.includes("action=txlist")) {
    return jsonResponse({ status: "1", result: [{
      hash: "evm-native-hash",
      from: "0x0000000000000000000000000000000000000002",
      to: evmAddress,
      value: "1000000000000000000",
      gasUsed: "21000",
      gasPrice: "1000000000",
      blockNumber: "19000001",
      timeStamp: "1700000004",
      txreceipt_status: "1",
    }] });
  }
  return jsonResponse({ error: "unexpected URL" }, 404);
}

try {
  const service = new TransactionService({
    dataDir,
    fetchImpl: mockFetch,
    providerConfig: {
      routescanBaseUrl: "https://routescan.test",
      tronBaseUrl: "https://trongrid.test",
      mempoolBaseUrl: "https://mempool.space/api",
      blockstreamBaseUrl: "https://blockstream.test/api",
      blockscout: { ETH: "https://blockscout.test" },
    },
  });

  const evm = await service.listTransactions({ address: evmAddress, networkKey: "ETH", limit: 10 });
  assert.equal(evm.items.length, 2);
  assert.equal(evm.items[0].schemaVersion, "2.0");
  assert.match(evm.items[0].provenance.rawResponseHash, /^[a-f0-9]{64}$/);
  assert.equal(evm.items.find((item) => item.operationType === "token_transfer").amount.value, "2.5");
  const legacyEvm = toLegacyTransaction(evm.items[0]);
  assert.equal(legacyEvm.normalizedV2.schemaVersion, "2.0");
  assert.equal(legacyEvm.hash, evm.items[0].id);

  const bnb = await service.listTransactions({ address: evmAddress, networkKey: "BNB", limit: 10 });
  assert.equal(bnb.items.length, 2);
  assert.equal(bnb.items.find((item) => item.operationType === "token_transfer").amount.value, "7.5");
  assert.equal(bnb.dataQuality.completeness, "partial");
  assert.ok(bnb.dataQuality.warnings.some((warning) => warning.includes("Binplorer")));

  const allEvm = await service.listTransactions({ address: evmAddress, networkKey: "ALL", limit: 100 });
  assert.equal(allEvm.network.key, "ALL");
  assert.ok(allEvm.items.some((item) => item.network.key === "BNB"));
  assert.ok(allEvm.items.some((item) => item.network.key === "ETH"));
  assert.ok(allEvm.items.some((item) => item.network.key === "ARB"));
  assert.equal(allEvm.dataQuality.networkChecks.length, 21);
  assert.equal(allEvm.scannedNetworks.length, 16);
  assert.equal(allEvm.skippedNetworks.length, 5);

  const tron = await service.listTransactions({ address: tronAddress, networkKey: "TRX", limit: 10 });
  assert.equal(tron.items.length, 1);
  assert.equal(tron.items[0].amount.symbol, "USDT");
  assert.equal(tron.items[0].direction, "out");

  const bitcoin = await service.listTransactions({ address: bitcoinAddress, networkKey: "BTC", limit: 10 });
  assert.equal(bitcoin.items.length, 1);
  assert.equal(bitcoin.items[0].direction, "out");
  assert.equal(bitcoin.items[0].amount.raw, "60500");
  assert.equal(bitcoin.items[0].inputs.length, 1);
  assert.equal(bitcoin.items[0].outputs.length, 2);
  assert.equal(bitcoin.items[0].metadata.changeOutputIsNotAsserted, true);

  const detected = await service.detectAddress({ address: evmAddress });
  assert.equal(detected.candidates.length, 21);
  assert.ok(detected.candidates.some((item) => item.network.key === "BNB"));
  assert.equal(detected.ambiguous, true);

  const rawLog = await readFile(join(dataDir, "raw_provider_responses", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf8");
  assert.ok(rawLog.trim().split("\n").length >= 4);
  process.stdout.write("API v2 contract checks passed.\n");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
