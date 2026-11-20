# API Providers

This file tracks what each provider can do in ChainSentra and how the API layer should combine them.

## Runtime Status

Use the local API endpoint to see configured providers and network coverage:

```bash
curl http://localhost:8787/api/providers
```

The endpoint does not expose secret values. It only reports whether required keys are present and which provider chain is active for each task.

## Provider Matrix

| Task | Primary | Secondary / Fallback | Current use |
| --- | --- | --- | --- |
| EVM live balance / nonce / block | Infura / MetaMask JSON-RPC | none yet | `eth_getBalance`, `eth_getTransactionCount`, `eth_blockNumber` |
| EVM native transactions | Public Blockscout instances | Binplorer for BNB, verified Routescan chains, optional owner Etherscan key | history, graph, risk |
| EVM ERC-20 transfers | Public Blockscout `tokentx` | Binplorer for BNB, verified Routescan chains, optional owner Etherscan key | history, graph, risk |
| EVM token balances | Alchemy Token API | planned: explorer token holders/balances where available | token portfolio panel |
| EVM NFT exposure | Alchemy NFT API | planned: explorer NFT APIs where available | NFT exposure panel |
| USD price enrichment | Alchemy Prices | DefiLlama Coins, stablecoin USD peg | transaction table, graph edges |
| TRON live profile | TronGrid | PostgreSQL cache for historical transactions | balance, latest tx, watchlist polling |
| TRON transactions | TronGrid account tx + TRC20 endpoints | PostgreSQL cache | history, graph, risk |
| Bitcoin live profile | Mempool.space | Blockstream Esplora, Blockchain.com | balance, tx count, block height |
| Bitcoin transactions | Mempool.space Esplora API | Blockstream Esplora, Blockchain.com, PostgreSQL cache | history, graph, risk |
| Attribution / labels | Arkham Intel API | OFAC Sanctions List Service, local analyst labels, sourced CSV imports | graph nametags, risk factors, sanctions exposure |
| Alerts | Local watchlist + Telegram Bot API | planned: provider webhooks | watchlist polling and notifications |

## Current Fallback Rules

### EVM History

1. Public Blockscout instances query `txlist` and `tokentx` for every network with a verified instance.
2. BNB Chain uses Binplorer address transactions and token-operation history. Its public `freekey` is real data but is limited to 100 recent operations and may limit history to 30 days.
3. Routescan is queried only for Avalanche C-Chain, Blast and Mantle, which were verified as supported. It is not used for BNB Chain.
4. An owner-supplied Etherscan API v2 key can extend coverage on networks included in that key's plan.
5. Each `All EVM` response contains `networkChecks`, `scannedNetworks` and `skippedNetworks`; unavailable providers are never interpreted as an empty wallet.

Every normalized transaction can include `amount`, `usdPrice`, `usdValue`, `priceProvider`, and `pricedAt`. Graph relevance prefers `usdValue` when available, with raw token amount as fallback.

### TRON History

1. TronGrid account transactions endpoint loads TRX/TRC10 history.
2. TronGrid TRC20 endpoint loads token transfer history.
3. PostgreSQL cache is used when live calls fail.

### Bitcoin History

1. Mempool.space loads address stats, latest block height, and confirmed address transactions.
2. Blockstream Esplora runs the same Esplora-compatible address and transaction flow as a second source.
3. Blockchain.com `rawaddr` is used as a different-format fallback and cross-check source.
4. PostgreSQL cache is used when live providers fail or are not configured.
5. UTXO transactions are normalized into `from`, `to`, `value`, `fee`, `direction`, and `BTC` native token fields for reuse by table, graph, and risk analysis.

## Provider Telemetry

External provider calls are recorded in PostgreSQL table `provider_call_events`. The API summarizes the last 24 hours by provider in `/api/providers`:

- call count
- successful call count
- error call count
- success rate
- average duration
- last error

### OFAC Sanctions Labels

`POST /api/entities/ofac` downloads OFAC SLS enhanced XML files, extracts digital currency address features and imports them into local entity labels with `category: "sanctions"`.
Default files are `SDN_ENHANCED.XML` and `CONS_ENHANCED.XML`; override them with `OFAC_SLS_FILES`.
Direct wallet matches against these sanctions labels apply a minimum AML risk score of `80`.

## Official References

- Etherscan API v2 account endpoints: https://docs.etherscan.io/api-reference/endpoint/txlist
- Etherscan v2 migration and multichain `chainid`: https://docs.etherscan.io/v2-migration
- Alchemy Token Balances: https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances
- Alchemy Token Metadata: https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-metadata
- Alchemy Transfers API: https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers
- Alchemy NFT API `getNFTsForOwner`: https://www.alchemy.com/docs/reference/nft-api-endpoints/nft-api-endpoints/nft-api-endpoints/get-nfts-for-owner
- Alchemy Prices API: https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-token-prices-by-symbol
- DefiLlama Coins API: https://defillama.com/docs/api
- Mempool.space API: https://mempool.space/docs/api
- Blockstream Esplora API: https://github.com/Blockstream/esplora/blob/master/API.md
- Blockchain.com Explorer API: https://www.blockchain.com/explorer/api
- OFAC Sanctions List Service: https://sanctionslistservice.ofac.treas.gov
- MetaMask / Infura JSON-RPC `eth_getBalance`: https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_getbalance/
- Blockscout account API: https://docs.blockscout.com/devs/apis/rpc/account
- Blockscout public instances: https://chains.blockscout.com/
- Binplorer address history API: https://github.com/amilabs/Binplorer/wiki/Binplorer-API
- TronGrid TRC20 transaction history: https://developers.tron.network/v4.0/docs/get-trc20-transaction-history

## Next API Work

1. Add ERC-20 contract-price enrichment for non-stable tokens by contract address.
2. Add NFT spam/scam classification into alerting and analyst workflows.
3. Add webhook-based alerts where providers support them, keeping polling as fallback.
4. Add a second independent BNB indexer for all-time cross-checking beyond the public Binplorer window.
