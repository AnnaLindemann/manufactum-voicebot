# Project Decisions

## D-001 — Custom backend

Accepted.

It protects credentials, normalizes external APIs, supports RAG, logging, tests, and stable Dialfire integration.

## D-002 — Start with API discovery

Accepted.

Observed responses are more reliable than assumptions.

## D-003 — No database during first API tests

Accepted.

A database is unnecessary until the API format is understood.

## D-004 — PostgreSQL and pgvector for RAG

Planned.

## D-005 — Version every document and chunk

Accepted.

Every chunk belongs to one immutable document version.

## D-006 — Price, stock, and reservation state never come from RAG

Accepted.

## D-007 — Begin RAG with an approved URL list

Accepted.

## D-008 — Deploy only after one local endpoint works

Accepted.

## D-009 — Link delivery is not part of the first milestone

Accepted.

The architecture must still leave room for it.

## D-010 — Voice calls do not reveal precise location

Accepted.

The bot must ask for city or postal code unless an external channel supplies coordinates.

## D-011 — Only observed, redacted responses define API contracts

Accepted.

Internal API contracts, domain models, validation schemas, and parsers may be derived only from
redacted responses actually observed during API discovery and recorded in `api-observation-report.md`.

Client-provided or vendor-provided example responses are not evidence. They may describe intended
behavior rather than real behavior, and storing them in the repository risks their being adopted as
an implicit source of truth for field names, response structure, or capabilities.

Consequences:

- `docs/api-spec.md`, which contained an unverified client-supplied example response, was removed
  and must not be restored;
- client-provided request details may be recorded only when explicitly labelled unverified, and only
  as starting points for experiments;
- connection details are supplied through environment variables
  (`MANUFACTUM_API_BASE_URL`, `MANUFACTUM_API_KEY`, `MANUFACTUM_API_KEY_HEADER`),
  not through committed documentation;
- a capability is treated as unsupported until an observation proves otherwise;
- `api-contracts.md` stays provisional until Phase 1 discovery is complete.

## D-012 — Structured error envelope and correlation logging begin with API routes

Deferred, with a fixed trigger.

The structured error envelope defined in `architecture.md`
(`code`, `safeCustomerMessage`, `retryable`, HTTP status) and the correlation-ID request logging
defined in `coding-standards.md` are **not** implemented in Phase 0.

Reason: Phase 0 exposes only `GET /health`, which has no upstream dependency, no customer-facing
failure mode, and no payload to redact. Building the envelope now would mean designing error codes
against an API whose failure behavior has not yet been observed, which conflicts with `D-011`.

Trigger: both must be implemented in the same phase that introduces the first API route
(Phase 2 — Internal API Contracts) and must exist before Phase 3 returns real product data.

Risk accepted: until then the application has no 404 handler and no error middleware, so unexpected
failures fall through to the Express default handler.

## D-013 — Type-aware ESLint enabled for Phase 1

Resolved in Phase 1. Type-aware linting is **enabled**.

The trigger recorded in Phase 0 was: before asynchronous API-client code is added in Phase 1,
evaluate enabling `recommendedTypeChecked`, in particular `no-floating-promises` and
`no-misused-promises`. Phase 1 added `scripts/test-search-api.ts`, which uses `fetch`, an
`AbortController` timeout, and an async `main()`. That trigger has fired, so the evaluation was
performed.

Outcome:

- `tseslint.configs.recommendedTypeChecked` is applied to `**/*.ts` in `eslint.config.js`, with
  `parserOptions.project` set to `./tsconfig.check.json`;
- `tsconfig.check.json` now includes `scripts` alongside `src` and `tests`. This was required,
  because type-aware rules need every linted file to belong to a TypeScript project, and `scripts/`
  previously belonged to none. As a side effect the discovery script is now type-checked by
  `npm run typecheck`, which it was not before;
- the type-aware rules are scoped to `**/*.ts`, so `eslint.config.js` itself is still linted with
  the untyped rule set. No other configuration was widened.

Rationale: the rules that matter for upstream HTTP work are exactly the ones that only exist in the
type-aware set. A floating promise in the discovery script or a future API client fails silently and
produces an unhandled rejection rather than a visible error, which is precisely the failure mode this
project cannot afford once real product, price, and stock data flows through it.

Checks run:

- `npm run lint` — passes with the type-aware rule set enabled;
- `npx eslint --print-config scripts/test-search-api.ts` — confirms `no-floating-promises`,
  `no-misused-promises`, `no-unsafe-assignment`, and `await-thenable` are set to error;
- a temporary probe file containing a deliberately floating promise was linted and correctly failed
  with `@typescript-eslint/no-floating-promises`, confirming that type information is wired up and
  the rules are not silently inert. The probe file was deleted and is not part of the repository;
- `npm run check` — passes in full.

No production or script code required changes: `scripts/test-search-api.ts` already terminated its
promise chain with `.catch()`.
