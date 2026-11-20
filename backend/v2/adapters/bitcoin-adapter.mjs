import { createNormalizedTransaction } from "../domain/transaction.mjs";
import { publicNetwork, validateAddressForNetwork } from "../networks/registry.mjs";
import { fetchJson } from "../providers/http-client.mjs";
import { NetworkAdapter, boundedInteger } from "./base-adapter.mjs";

function safeSats(value) {
  const text = String(value ?? "0");
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

function inputModel(input, index) {
  const prevout = input.prevout || {};
  return {
    index,
    previousTxHash: input.txid || null,
    previousOutputIndex: input.vout ?? null,
    addresses: [prevout.scriptpubkey_address].filter(Boolean),
    value: { raw: safeSats(prevout.value).toString(), decimals: 8, symbol: "BTC" },
    scriptType: prevout.scriptpubkey_type || null,
  };
}

function outputModel(output, index) {
  return {
    index,
    addresses: [output.scriptpubkey_address].filter(Boolean),
    value: { raw: safeSats(output.value).toString(), decimals: 8, symbol: "BTC" },
    scriptType: output.scriptpubkey_type || null,
    script: output.scriptpubkey || null,
  };
}

function normalizeTransactions({ rows, network, observedAddress, provenance }) {
  const target = observedAddress.toLowerCase();
  return rows.map((row) => {
    const inputs = (row.vin || []).map(inputModel);
    const outputs = (row.vout || []).map(outputModel);
    const inputTotal = inputs
      .filter((input) => input.addresses.some((address) => address.toLowerCase() === target))
      .reduce((sum, input) => sum + BigInt(input.value.raw), 0n);
    const outputTotal = outputs
      .filter((output) => output.addresses.some((address) => address.toLowerCase() === target))
      .reduce((sum, output) => sum + BigInt(output.value.raw), 0n);
    const net = outputTotal - inputTotal;
    const amount = net < 0n ? -net : net;
    const fromAddresses = [...new Set(inputs.flatMap((input) => input.addresses))];
    const toAddresses = [...new Set(outputs.flatMap((output) => output.addresses))];
    const txHash = row.txid;

    return createNormalizedTransaction({
      id: `${network.key}:${txHash}`,
      txHash,
      network: publicNetwork(network),
      observedAddress,
      block: { number: row.status?.block_height ?? null, hash: row.status?.block_hash || null },
      timestamp: row.status?.block_time ?? null,
      status: row.status?.confirmed ? "confirmed" : "mempool",
      operationType: "utxo_transaction",
      direction: net < 0n ? "out" : net > 0n ? "in" : "self",
      fromAddresses,
      toAddresses,
      amount: { raw: amount.toString(), decimals: 8, symbol: "BTC", assetType: "native" },
      fee: { raw: safeSats(row.fee).toString(), decimals: 8, symbol: "BTC" },
      inputs,
      outputs,
      explorerUrl: `${network.explorerBaseUrl}/tx/${txHash}`,
      provenance,
      metadata: {
        observedInputRaw: inputTotal.toString(),
        observedOutputRaw: outputTotal.toString(),
        amountSemantics: "absolute net flow for the observed address",
        changeOutputIsNotAsserted: true,
      },
    });
  });
}

export class BitcoinAdapter extends NetworkAdapter {
  constructor(options) {
    super(options);
    this.providers = [
      { name: "Mempool.space", baseUrl: String(options.mempoolBaseUrl || "https://mempool.space/api").replace(/\/$/, "") },
      { name: "Blockstream Esplora", baseUrl: String(options.blockstreamBaseUrl || "https://blockstream.info/api").replace(/\/$/, "") },
    ];
  }

  validateAddress(address) {
    return validateAddressForNetwork(address, this.network.key);
  }

  async listTransactions({ address, limit = 25, cursor = "", from = null, to = null }) {
    if (!this.validateAddress(address)) {
      const error = new Error("Invalid Bitcoin address");
      error.statusCode = 400;
      throw error;
    }
    const safeLimit = boundedInteger(limit, 25, 1, 25);
    const suffix = cursor ? `/chain/${encodeURIComponent(cursor)}` : "";
    const errors = [];

    for (const provider of this.providers) {
      const url = `${provider.baseUrl}/address/${encodeURIComponent(address)}/txs${suffix}`;
      try {
        const payload = await fetchJson(url, { provider: provider.name, fetchImpl: this.fetchImpl });
        if (!Array.isArray(payload)) throw new Error(`${provider.name} returned an invalid transaction list`);
        const archived = await this.archive({
          provider: provider.name,
          operation: "address_transactions",
          request: { url, address, limit: safeLimit, cursor: cursor || null },
          response: payload,
        });
        const provenance = {
          provider: provider.name,
          retrievedAt: archived.retrievedAt,
          rawResponseId: archived.id,
          rawResponseHash: archived.contentHash,
        };
        const minTime = from ? Date.parse(from) : null;
        const maxTime = to ? Date.parse(to) : null;
        const items = normalizeTransactions({ rows: payload, network: this.network, observedAddress: address, provenance })
          .filter((item) => !Number.isFinite(minTime) || (item.timestamp && Date.parse(item.timestamp) >= minTime))
          .filter((item) => !Number.isFinite(maxTime) || (item.timestamp && Date.parse(item.timestamp) <= maxTime))
          .slice(0, safeLimit);
        const hasMore = payload.length >= 25;
        return {
          items,
          pagination: {
            page: null,
            limit: safeLimit,
            cursor: hasMore ? payload.at(-1)?.txid || null : null,
            hasMore,
          },
          providers: [provider.name],
          errors,
          completeness: hasMore ? "paginated" : "complete_page",
        };
      } catch (error) {
        errors.push(`${provider.name}: ${error.message}`);
      }
    }
    throw new Error(errors.join(" | ") || "Bitcoin history providers failed");
  }
}
