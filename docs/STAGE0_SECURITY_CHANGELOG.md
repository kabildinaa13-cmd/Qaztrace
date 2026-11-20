# Этап 0: первая стабилизация

Дата: 02.08.2026

Реализовано:

- allowlist CORS вместо `*`;
- лимит JSON request body и корректные HTTP 400/413;
- случайный fallback-секрет сессии вместо секрета, вычисляемого из DATABASE_URL;
- обязательная аутентификация для Label DB и wallet analysis endpoints;
- frontend передаёт bearer token во все защищённые запросы;
- удалены offline/localStorage fallback-копии профилей, watchlist и alerts;
- добавлен hash-chained Audit Log для дел, профилей, меток и watchlist;
- добавлен экран Audit Log;
- добавлен явный data mode/completeness для таблицы транзакций и графа;
- watchlist, сохранённые дела и полнота источников больше не увеличивают Risk Score;
- добавлен изолированный security smoke test с временным хранилищем.

Проверки:

```text
node --check backend/server.mjs
npm run test:security
npm run build -- --configLoader runner
```

Оставшиеся ограничения:

- bearer token пока хранится в localStorage; требуется переход на HttpOnly session cookie/корпоративный SSO;
- Audit Log является SHA-256 hash chain, но ещё не вынесен в WORM/append-only storage;
- нет RBAC и case-level ACL;
- legacy backend и frontend остаются монолитными;
- для production обязателен собственный `AUTH_SECRET` и явный `CORS_ALLOWED_ORIGINS`.
