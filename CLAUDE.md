# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repository. To **deploy** ai-chat, follow README.md — it is written to be executed step by step.

## What this is

A self-hostable AI chat platform: three services in `server/` (chat-app, chat-socket, chat-expert) built from one image, an admin dashboard in `dashboard/`, a client SDK in `sdk/js/`. README.md → "How it works" and `docs/architecture.html` explain the flows; read them before changing the conversation pipeline.

## Commands

```bash
npm ci && npm run build -w sdk/js      # the dashboard depends on the SDK build
npm run typecheck && npm run lint && npm test
REDIS_URL=redis://localhost:6379/15 npm run test:integration -w server
npm run dev:app | dev:socket | dev:expert | dev:dashboard
AIC_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke:dev -w server   # end to end against running services
```

## Architecture rules

- **Service boundaries are structural.** chat-socket has no database and no business logic. chat-expert reads configuration only and never writes. chat-app owns every write to conversation tables. ESLint (`no-restricted-imports`) enforces that services never import each other. Shared code lives in `server/src/shared`.
- **Contracts are single-sourced** in `server/src/shared/contracts/`. Both sides of a queue import the same file. Never redefine these shapes.
- **Layers:** controllers validate (zod schemas through `ZodValidationPipe`) and delegate. Services hold the business logic. Repositories hold every query. No SQL or `Repository<T>` calls outside a repository class.
- **Idempotency everywhere.** Every queue handler must tolerate redelivery. Use deterministic ids plus unique keys, and compare-and-set UPDATEs for state transitions (see `ConversationRepository`). Never "check then insert".
- **One generation in flight per conversation** (`conversations.inflight_dispatch_id`). Do not dispatch around it.
- **Agent behaviour is data.** New per-agent knobs go in `shared/domain/agent-settings.ts` (zod schema with defaults). The dashboard reads defaults and limits from `/admin/api/meta`.

## Database

- MySQL 8. No foreign keys: referenced ids are indexed BIGINT columns, related data is read with joins. No database ENUM types: VARCHAR columns plus TypeScript enums in `shared/domain/enums.ts`.
- Migrations live in `shared/database/migrations/`, registered in `data-source.ts`, and must be backward compatible with the previous release. Add nullable or defaulted columns; never drop or rename in the same release that stops using something. Entities must match the DDL exactly. Columns are snake_case (via `SnakeNamingStrategy`); properties are camelCase.
- Select only the columns you need for listings. Paginate with keyset cursors on `id`, never OFFSET.

## Code style

- TypeScript strict. Explicit return types on public methods. No `any`.
- Logging: `getLogger(ClassName.name)` from `shared/logger/logger.ts`. Never construct another logger, and never log secrets, tokens or message bodies. Pass errors through `describeError()`.
- Errors that reach HTTP are `AppError` subclasses (`shared/errors/app-errors.ts`). Never throw a bare `Error` from a request path.
- Configuration only through `shared/config/config.ts`. Add new variables there, to `.env.example`, and to the README table.
- Comments explain *why*, not *what*. Remove dead code; no commented-out code.
- Tests: `*.spec.ts` next to the code (unit, no I/O), `*.integration.ts` for tests needing MySQL or Redis. Change behaviour → change tests.

## Dashboard

React + Vite + TanStack Query, plain CSS with tokens in `dashboard/src/styles.css` (light and dark). All API calls go through `dashboard/src/lib/api.ts`. Forms show server validation errors per field via `fieldError()`.
