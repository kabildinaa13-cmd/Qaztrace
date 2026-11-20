# ChainSentra

## Professionalization status

- Current architecture audit: [`docs/ARCHITECTURE_AUDIT_2026-08-02.md`](docs/ARCHITECTURE_AUDIT_2026-08-02.md)
- Migration roadmap: [`docs/PROFESSIONALIZATION_ROADMAP.md`](docs/PROFESSIONALIZATION_ROADMAP.md)
- Stage 0 security changelog: [`docs/STAGE0_SECURITY_CHANGELOG.md`](docs/STAGE0_SECURITY_CHANGELOG.md)
- API v2 transaction contract: [`docs/API_V2_TRANSACTION_CONTRACT.md`](docs/API_V2_TRANSACTION_CONTRACT.md)
- Stage 1 changelog: [`docs/STAGE1_CHANGELOG.md`](docs/STAGE1_CHANGELOG.md)
- Stage 1 UI migration: [`docs/STAGE1_UI_MIGRATION.md`](docs/STAGE1_UI_MIGRATION.md)
- The current application is a protected research prototype. It must not be described as a finished forensic platform until the roadmap acceptance gates are complete.

## Windows without Docker

Run the app directly on Windows with local JSON storage:

```powershell
.\start-windows.bat
```

The script creates `.env` from `.env.example` when needed, installs npm dependencies when `node_modules` is missing, then opens two PowerShell windows:

- API: `http://localhost:8787` with `STORAGE_DRIVER=json`
- Frontend: `http://localhost:5174`

Close both opened PowerShell windows to stop the app.

## Docker

```bash
docker compose up --build
```

Frontend: http://localhost:5174
API: http://localhost:8787
PostgreSQL: `postgres://chainsentinel:chainsentinel@localhost:5432/chainsentinel`

On first API start, old JSON data from `backend/data/*.json` is imported into PostgreSQL if the matching table is empty.

## Transaction providers

Provider configuration and runtime coverage can be inspected without exposing secrets:

```bash
curl http://localhost:8787/api/providers
```

Detailed provider notes live in [`docs/API_PROVIDERS.md`](docs/API_PROVIDERS.md).

EVM transaction history uses multiple real-data providers:

1. public Blockscout instances for Ethereum, Arbitrum, Base, Celo, Hemi, Linea, MegaETH, Optimism, Polygon, Scroll, Unichain and ZKsync;
2. the public Binplorer `freekey` for recent BNB Chain native and token operations;
3. Routescan only for the networks verified to support it: Avalanche C-Chain, Blast and Mantle;
4. Etherscan API v2 for additional networks when the owner configures their own `ETHERSCAN_API_KEY`;
5. the real provider-response cache if a live provider is temporarily unavailable.

`All EVM` scans every network with a configured history source and returns a per-network status. A provider error is never converted into “no transactions found”. Networks without a source are listed as not checked.

The transaction pipeline includes native transfers plus ERC-20/TRC-20 token transfers. Token events are normalized into the same table and risk engine, so stablecoin flows such as USDT/USDC fast exits, split transfers and exchange deposits are scored together with native ETH/TRX movements.

EVM token balances use Alchemy Token API (`alchemy_getTokenBalances` + `alchemy_getTokenMetadata`). TRON history uses TronGrid native account transactions plus TRC20 transfer history. Arkham enriches graph nodes and risk factors with entity/label/tag attribution when `ARKHAM_API_KEY` is configured.

To enable Arkham, request access in the Arkham API portal, create your personal API key, then add the following lines to the local `.env` file. Never place the key in browser code or share it in a report.

```dotenv
ALLOW_CREDENTIALLED_PROVIDERS=true
ARKHAM_API_KEY=YOUR_API_KEY_HERE
ARKHAM_HOST=api.arkm.com
```

Restart the local API after changing `.env`. In ChainSentra, Arkham results appear in the wallet intelligence panel and as entity/label enrichment on supported graph nodes.

Transactions and graph edges are enriched with USD estimates when possible:

- stablecoins use a conservative USD peg;
- native assets use Alchemy Prices when `ALCHEMY_API_KEY` is configured;
- DefiLlama Coins API is used as the no-key fallback for native assets.

NFT exposure is available for EVM wallets through Alchemy NFT API:

```bash
curl "http://localhost:8787/api/wallets/<address>/nfts?networkKey=ETH&limit=24"
```

Bitcoin address support uses three public providers: Mempool.space, Blockstream Esplora and Blockchain.com. BTC live profile, transaction history, graph and risk endpoints use the same API shapes as EVM/TRON:

```bash
curl "http://localhost:8787/api/wallets/<btc-address>/live"
curl "http://localhost:8787/api/wallets/<btc-address>/transactions?networkKey=BTC&limit=25"
curl "http://localhost:8787/api/wallets/<btc-address>/graph?networkKey=BTC"
```

Provider latency/error telemetry is stored in PostgreSQL and summarized by:

```bash
curl http://localhost:8787/api/providers
```

Default Blockscout endpoints are included for all public instances listed above. Override one without changing code by setting:

```bash
BLOCKSCOUT_<NETWORK_KEY>_URL=https://your-blockscout-instance
```

Example:

```bash
BLOCKSCOUT_BASE_URL=https://base.blockscout.com
```

## Data policy

Demo, mock, fixture, synthetic and seed records are disabled at the backend storage boundary. The application accepts only live provider data, cached real provider responses, analyst-created records and explicitly sourced imports. Test-alert generation and seed-label import endpoints are not part of the runtime API.

## Entity labels

The `Биржи` page checks three evidence layers:

1. local verified/imported labels;
2. public Blockscout address tags for Ethereum (works without an API key);
3. public TRONSCAN account labels for TRON (requires a key created in your own TRONSCAN account).

To enable TRON exchange labels, create your own key at `https://tronscan.org/#/myaccount/apiKeys`, then add only to the local `.env` file:

```bash
ALLOW_CREDENTIALLED_PROVIDERS=true
TRONSCAN_API_KEY=YOUR_API_KEY_HERE
```

Restart `npm run api` after editing `.env`. Never paste the key into the browser, screenshots, reports, source code, or chat. A missing label means only that the configured sources did not identify the address; it is not proof that the address is unrelated to an exchange.

OFAC digital currency addresses can be imported from the public Sanctions List Service.
By default ChainSentra downloads `SDN_ENHANCED.XML` and `CONS_ENHANCED.XML`, extracts digital currency address features and saves them as `sanctions` entity labels:
Direct matches against these sanctions labels set the wallet AML risk score to at least `80`.

```bash
curl -X POST http://localhost:8787/api/entities/ofac
```

The checked-in local risk database also includes:

- Poison-Hunter CCS 2024 phishing ground-truth addresses: `5890` ETH scam labels.
- Etherscan benign addresses from the Poison-Hunter dataset: `1154` ETH benign labels.
- FBI DPRK TraderTraitor BTC stolen-funds addresses from the August 22, 2023 press release: `6` BTC scam labels.

Direct `sanctions` and `scam` matches contribute `80` risk points. Direct `benign` matches contribute `1` point and are kept as low-risk reference labels, not scam indicators.

To rebuild these static labels from local source files in `backend/data/external/`:

```bash
npm run import:risk-labels
```

Override the SLS source or files with:

```bash
OFAC_SLS_BASE_URL=https://sanctionslistservice.ofac.treas.gov
OFAC_SLS_FILES=SDN_ENHANCED.XML,CONS_ENHANCED.XML
```

Good sources for expanding the label base:

- OFAC SDN / sanctions list digital currency addresses.
- Etherscan public name tags and label pages.
- TRONSCAN account labels for TRON entities.
- Arkham Intel labels/entities.
- Flipside label tables for chain-specific research datasets.

Treat static labels as analyst-maintained data. Exchange deposit addresses and hot wallets change over time, so verify labels against at least one current explorer or intelligence source before relying on them for high-confidence attribution.
