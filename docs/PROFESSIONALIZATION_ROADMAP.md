# Дорожная карта профессионализации ChainSentra

Основание: `ARCHITECTURE_AUDIT_2026-08-02.md`.

## Стратегия миграции

Использовать постепенную замену (strangler pattern): текущий Node API остаётся legacy-слоем, пока соответствующий endpoint не реализован и не проверен в API v2. Данные мигрируются, а не удаляются. Каждый этап завершается автоматическими тестами, проверкой UI и перечнем реально работающих провайдеров.

## Этап 0. Стабилизация существующего прототипа

Цель: исключить потерю данных и закрыть наиболее опасные места до расширения.

- резервная копия и инициализация версионирования;
- обязательная аутентификация для всех операций с делами, метками, отчётами и анализом;
- allowlist CORS;
- ограничение body/rate limits;
- режимы live/cached/imported/demo и явный индикатор полноты;
- удаление криминального risk-веса у watchlist/cases/data quality;
- append-only security/audit events для ручных изменений;
- базовые smoke/unit tests legacy API;
- запрет хранения следственных материалов в frontend localStorage как основного источника.

Критерий готовности: существующие TRON/BTC/EVM функции работают после перезапуска; неавторизованный пользователь не может читать материалы дела или менять метки.

## Этап 1. Модульное ядро и четыре первые сети

### Backend v2

Модули:

```text
app/
  api/v2/
  core/
  auth/
  cases/
  entities/
  wallets/
  transactions/
  evidence/
  audit/
  integrations/
    evm/
    tron/
    utxo/
  models/
  schemas/
  repositories/
  workers/
```

Целевой стек: FastAPI, Pydantic, SQLAlchemy, Alembic и PostgreSQL. До появления v2 legacy Node server продолжает обслуживать работающие endpoints.

### Нормализованные сущности

- users, roles, case_members;
- cases, case_subjects, case_identifiers;
- addresses, networks, address_activity;
- transactions, transaction_operations;
- assets, token_contracts;
- raw_provider_responses, provider_calls;
- labels, label_sources, label_verifications;
- evidence_items, evidence_hashes;
- audit_events.

### Первые адаптеры

- Ethereum и BNB Chain через общий EVM adapter;
- TRON adapter;
- Bitcoin UTXO adapter.

Каждый адаптер реализует validate/detect/balance/assets/transactions/transaction/decode/counterparties/normalize и возвращает provider metadata.

### Frontend

- TypeScript;
- React Query;
- отдельные feature-модули cases/search/address/transactions/settings;
- карточка дела из полного ТЗ;
- определение активности 0x во всех настроенных EVM-сетях;
- единая таблица транзакций с provenance/data-quality.

Критерий готовности: четыре сети возвращают только реальные или явно cached данные, raw response сохранён с SHA-256, а история может синхронизироваться постранично.

## Этап 2. Граф, конкретная сумма и деанонимизация

- Cytoscape.js или Sigma.js;
- граф адресов, сервисов и off-chain сущностей;
- фильтры времени, сети, актива, категории и суммы;
- кластеризация и ручные метки с audit;
- экспорт PNG/SVG/PDF;
- единый trace engine с proportional по умолчанию;
- FIFO/LIFO/haircut/poison/direct matching;
- полноценный UTXO trace и change/CoinJoin эвристики;
- Label DB и CEX deposit/hot/cold/sweep типы;
- точки возможной деанонимизации;
- доказательная таблица;
- PDF/DOCX/CSV/XLSX/JSON отчёты.

Критерий готовности: выбранная сумма сопровождается методикой, остатком, процентом, confidence и ограничениями; CEX прекращает публичную цепочку, а не создаёт ложное продолжение.

## Этап 3. Risk, Pattern Engine и запросы

- объяснимый Risk Score по независимым категориям;
- data quality/confidence отдельно от risk;
- Pattern Engine с версионируемыми правилами;
- mixer: direct/indirect/behavioral/insufficient;
- EVM ABI/events/swaps/DEX/bridge decoding;
- генератор проекта запроса в биржу;
- неизменяемый Audit Log и версии отчётов;
- S3-compatible evidence storage;
- Redis/Celery для jobs, progress, retry и cancellation.

Критерий готовности: каждый риск воспроизводится из конкретных фактов/правил; изменение метки или отчёта оставляет audit trail.

## Этап 4. Дополнительные сети и кроссчейн

- Solana/SPL/Jupiter;
- XRP Ledger/destination tag/trust lines;
- Litecoin, Dogecoin, Bitcoin Cash;
- Polygon, Arbitrum, Base, Optimism, Avalanche как полностью поддержанные EVM;
- bridge matching и cross-chain trace;
- watchlist incremental sync, email/Telegram/webhook;
- Neo4j при подтверждённой необходимости, а не как обязательная преждевременная зависимость.

Критерий готовности: сеть определяется по активности, а не только формату; кроссчейн-связь содержит обе транзакции и confidence.

## Порядок ближайших изменений

1. Добавить тестируемые domain schemas и network registry.
2. Защитить legacy mutation/analysis endpoints и CORS.
3. Добавить provenance/data-quality envelope в ответы legacy API.
4. Ввести append-only audit для меток и дел.
5. Подготовить PostgreSQL typed schema и мигратор JSON без удаления исходных файлов.
6. Поднять API v2 и перенести Ethereum/BNB, TRON и Bitcoin по одному адаптеру.
7. Разделить frontend после стабилизации API-контрактов.

## Что требует внешней настройки

- Etherscan/Alchemy/Arkham: собственные ключи организации, хранящиеся только на сервере;
- PostgreSQL: production credentials и backup policy;
- Redis/Celery: отдельные процессы;
- S3: bucket, encryption и retention policy;
- Telegram/email/webhook: разрешённые каналы и секреты;
- актуальная коммерческая/ведомственная база CEX deposit labels при необходимости высокой полноты атрибуции;
- KYC и движение внутри биржи — только официальный ответ сервиса, не публичный blockchain API.

