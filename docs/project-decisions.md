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

## D-012 — Structured error envelope and correlation logging begin with the first API route

Deferred, with a fixed trigger. **Trigger restated in Phase 2.**

The structured error envelope defined in `architecture.md`
(`code`, `safeCustomerMessage`, `retryable`, `correlationId`, HTTP status) and the correlation-ID
request logging defined in `coding-standards.md` are **not** implemented in Phase 0, and are **not**
implemented in Phase 2.

Reason: Phase 0 exposes only `GET /health`, which has no upstream dependency, no customer-facing
failure mode, and no payload to redact. Building the envelope then would have meant designing error
codes against an API whose failure behavior had not yet been observed, which conflicts with `D-011`.

Trigger: both must be implemented **in the same phase that introduces the first API route, which is
Phase 3 — Product Search, Price, and Availability**, and must exist before that route returns real
product data.

### Why the trigger names Phase 3 and not Phase 2

The original wording assumed the first API route would appear in Phase 2, and named Phase 2
parenthetically. That assumption did not hold. `D-014` establishes that Phase 2 is a
documentation-only phase producing a contract, and that the first route appears in Phase 3.

The trigger itself is unchanged: it has always been _the phase that introduces the first API route_.
Only the phase number satisfying it has moved, because the route moved. The safety requirement is
also unchanged, and is in fact tightened: the envelope, correlation logging, the error middleware,
and the 404 handler must all be in place in Phase 3 **before** the product-search route returns real
product data, not merely in the same phase.

Deferring the envelope to Phase 3 rather than building it in Phase 2 also keeps it consistent with
`D-011`. The error codes are now designed against the failure behavior actually observed in Phase 1
and recorded in `api-contracts.md`, and they are implemented in the same phase as the code paths that
raise them, so no code path is written against an untested envelope.

The error codes, HTTP statuses, retryable flags, and handling rules are already agreed and documented
in `api-contracts.md`. Phase 3 implements them; it does not redesign them.

Risk accepted: until Phase 3 the application has no 404 handler and no error middleware, so
unexpected failures fall through to the Express default handler. This risk is unchanged in size,
because the only route that exists in the meantime is `GET /health`, which has no upstream dependency
and no customer-facing failure mode.

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

## D-014 — Phase 2 produces a documented contract only; the first route is Phase 3

Accepted.

Phase 2 — Internal API Contracts creates documentation only. It adds no route, no schema code, no
upstream client, no middleware, and no tests. Its deliverable is the agreed MVP contract for
`GET /api/products/search` in `api-contracts.md`.

Phase 3 — Product Search, Price, and Availability introduces the first API route, together with
everything that route requires to fail safely: the upstream client, request and response schemas, the
mapper, correlation-ID logging, the Express error middleware, the 404 handler, and tests.

Reason: `roadmap.md` already defines Phase 2's deliverable as reviewed API contracts and Phase 3's as
a working product-search backend. Letting Phase 2 return real product data would collapse the two
phases and make the Phase 3 acceptance gate meaningless.

The route and its error handling are kept in one phase deliberately. Splitting them — a route in one
phase, its error middleware in the next — would mean shipping a route whose failure modes fall
through to the Express default handler, which is precisely the risk `D-012` exists to close.

Consequences:

- `D-012`'s trigger is satisfied in Phase 3, not Phase 2;
- the Phase 2 acceptance gate is documentation consistency, not a passing endpoint test;
- evaluation Level 1 for Phase 2 is limited to the checks that a documentation-only phase can
  exercise; no endpoint behavior may be recorded as PASS, because none exists.

## D-015 — MVP product-search contract is deliberately narrower than the domain model

Accepted.

The MVP contract exposes only what is needed to answer a product-search question safely, even where
more data was observed upstream.

Excluded although observed upstream:

- `manufactum` product field `manufacturer` — not needed to answer an MVP search question, and every
  exposed field is one the contract must then keep stable;
- `status_text` — upstream-controlled free text; exposing it would let an upstream wording change flow
  straight into a spoken answer with no schema check;
- a numeric price. The upstream `price` was observed only as a localized string such as `"11,90 €"`.
  Parsing it would invent structure from a single observed format, and a mis-parse would make the bot
  speak a wrong price — the failure mode `test-strategy.md` ranks first among its acceptance criteria.
  Only `priceText` is returned, verbatim, and consumers speak it as-is.

Excluded as an internal choice:

- `checkedAt` — response freshness is inherently request-time; the field implied caching semantics
  that do not exist. Timing stays in correlation logs;
- any reason code accompanying an empty availability list. An unknown warehouse and a warehouse for
  which upstream returned nothing are shape-identical, so any explanatory flag would dress an
  unresolved ambiguity in the language of a finding.

Internal request bounds, which are decisions and not observed upstream limits:

- `limit` is restricted to 1–5 with a default of 5. No upstream maximum was ever established. The
  ceiling reflects what a voice caller can absorb, and it makes the undocumented upstream
  normalization of `limit=0` and negative values unreachable by design.

Retained defensively:

- `status: "unknown"` for an unrecognized upstream status. No observed value produces it. It exists so
  one odd availability entry degrades instead of failing a whole response or being coerced into
  `in_stock`. It is logged with its raw value and must never be spoken as stock information.

This decision is reversible without new discovery, because every exclusion is a choice about what to
expose rather than a gap in evidence. `manufacturer` and `status_text` remain modelled in the raw
upstream schema, so they can be exposed later without another discovery phase.
