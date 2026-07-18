# Phase 3 Implementation Report

## Phase

Phase 3 — Product Search, Price, and Availability.

## Summary

Phase 3 implements the first API route, `GET /api/products/search`, exactly as agreed in
`api-contracts.md`. It does not redesign the contract.

The route is backed by an environment-configured client for the one observed upstream endpoint,
`GET /search`. Request validation runs at the internal boundary before any upstream call, the
upstream response is validated against a raw snake_case schema and then converted by a pure mapper,
and every non-2xx response leaves through one central error middleware as the agreed envelope.

Four review corrections have since been applied. Three are recorded in `D-016`: the upstream timeout
was raised from 5 s to 8 s and made configurable; `manufacturer` and `status_text` were made optional
in the raw upstream schema, because neither is a public-contract field; and `x-correlation-id` became
the only accepted inbound correlation header. A fourth, recorded in `D-017`, splits the single
ambiguous `latencyMs` log field into `upstreamLatencyMs` and `requestLatencyMs`.

The four requirements `D-012` attaches to the first route — the structured error envelope,
correlation-ID logging, the central Express error middleware, and the 404 handler — are all in place
and are exercised by tests.

## Scope

- Included:
  - `GET /api/products/search`: route, validation, application service, upstream client, raw upstream
    schema, and pure mapper;
  - the agreed error envelope, error-code table, correlation-ID middleware, request logging, central
    error middleware, and 404 handler;
  - unit, integration, and contract tests against mocks and the stored redacted Phase 1 sample.

- Explicitly excluded, as instructed and per `roadmap.md`:
  - Dialfire, deployment, database, and RAG;
  - reservations, store resolution, online availability, alternatives, categories, and variants;
  - any upstream endpoint other than the observed `GET /search`;
  - ambiguity resolution and exact-match determination: the ranked list is returned as received;
  - distinguishing an unknown warehouse from a warehouse with no stock, which needs the Phase 4 store
    registry.

## Files changed

Added:

- `src/config/manufactum-config.ts` — environment-based upstream configuration, read lazily; holds
  `DEFAULT_UPSTREAM_TIMEOUT_MS` as the single source of truth for the timeout.
- `src/domain/product-search.ts` — internal camelCase models and the closed status enum.
- `src/errors/app-error.ts` — `AppError`, the agreed error-code table, and the envelope builder.
- `src/logging/logger.ts` — structured JSON logger over a deliberately narrow field set.
- `src/http/correlation-id.ts` — inbound-or-generated correlation ID, echoed as a response header.
- `src/http/locals.ts` — typed `response.locals` shared between middlewares.
- `src/http/request-logger.ts` — one structured line per completed request.
- `src/http/error-middleware.ts` — 404 handler and central error middleware.
- `src/http/product-search-route.ts` — the thin route handler.
- `src/http/validation/product-search-request.ts` — request schema and `INVALID_REQUEST` mapping.
- `src/integrations/manufactum/upstream-schema.ts` — raw upstream schema.
- `src/integrations/manufactum/mapper.ts` — pure mapper.
- `src/integrations/manufactum/product-search-client.ts` — upstream client, timeout, error mapping.
- `src/services/product-search-service.ts` — application service; adds `warehouseFilterApplied`.
- `src/observability/request-context.ts` — per-request correlation ID and upstream-latency sink,
  free of any Express type so the integration layer stays independent of HTTP.
- `tests/helpers/test-doubles.ts` — recording logger, fetch stub, redacted-sample loader.
- `tests/unit/app-error.test.ts`, `tests/unit/product-search-request.test.ts`,
  `tests/unit/mapper.test.ts`, `tests/unit/product-search-client.test.ts`,
  `tests/unit/manufactum-config.test.ts`, `tests/unit/request-context.test.ts`.
- `tests/integration/product-search-route.test.ts`.
- `tests/contract/redacted-sample.test.ts`.
- `docs/phase-3-implementation-report.md` — this report.

Modified:

- `src/app.ts` — `createApp()` factory wiring middleware and the route, with injectable logger and
  product-search service; `app` is still exported so the Phase 0 health test is unchanged.
- `src/server.ts` — loads `dotenv/config`. It is loaded here rather than in `app.ts` so that
  importing the app in a test never reads a local `.env`.
- `.env.example` — `MANUFACTUM_API_TIMEOUT_MS` added, documented as optional with a default of 8000.
- `docs/api-contracts.md` — timeout, correlation-header, and upstream-validation sections updated.
- `docs/project-decisions.md` — `D-016` added.

No file was committed.

## Functionality added

- `GET /api/products/search` returning `query`, `resultCount`, `warehouseFilterApplied`, `products`.
- Search by keyword and by article number, both served by the same upstream call.
- Request validation: `q` trimmed 1–200; `warehouseId` trimmed 1–64 and opaque; `limit` an integer
  1–5, defaulting to 5 and always sent upstream explicitly. Invalid input never reaches upstream.
- `priceText` carried through verbatim and unparsed. `manufacturer` and `status_text` are parsed from
  upstream and stop at the mapping boundary.
- Status mapping `AVAILABLE` → `in_stock`, `OUT_OF_STOCK` → `out_of_stock`, anything else →
  `unknown`, logged with its raw value and with `stock` carried through unchanged.
- No results returned as a normal `200` with `resultCount: 0`; an empty availability list returned as
  `[]` with no reason code and no stock claim.
- Upstream response validated, never cast; a missing or wrongly typed mapped field rejects the whole
  response as `UPSTREAM_INVALID_RESPONSE`. Unknown extra upstream fields are ignored.
- Structured errors with fixed internal statuses `{200, 400, 404, 500, 502, 504}`. No upstream status
  code and no upstream body text reaches a caller.
- Correlation ID taken from `x-correlation-id` when present, generated otherwise, echoed in the
  response `x-correlation-id` header and in every error envelope. `x-request-id` is ignored.
- Upstream timeout of 8 seconds, held once in `DEFAULT_UPSTREAM_TIMEOUT_MS` and overridable per
  environment through `MANUFACTUM_API_TIMEOUT_MS`. No retry logic accompanies it.
- Two named latency metrics: `upstreamLatencyMs` for the Manufactum call alone and
  `requestLatencyMs` for total backend handling, both reported on the request-completion line when an
  upstream call occurred. `upstreamLatencyMs` is absent, not zero, when no upstream call was made.

## Checks and tests run

| Check                                 | Result                      |
| ------------------------------------- | --------------------------- |
| Type check (`npm run typecheck`)      | Pass                        |
| Lint (`npm run lint`)                 | Pass                        |
| Format check (`npm run format:check`) | Pass                        |
| Tests (`npm test`)                    | Pass — 143 tests, 9 files   |
| Build (`npm run build`)               | Pass                        |
| `npm run check` (all of the above)    | Pass                        |
| `git diff --check`                    | Pass — no whitespace errors |
| Manual verification, built server     | Pass — see below            |

Test coverage maps to `test-strategy.md` § Product-search tests:

- mapping: the stored redacted sample maps to the expected internal model; status mapping including
  near-miss values such as `available` and `AVAILABLE `; `priceText` byte-identical; `manufacturer`
  and `status_text` absent from output, asserted structurally; missing or wrongly typed upstream
  fields rejected rather than partially mapped;
- upstream strictness, added in review: a product missing any mapped field (`price`, `sku`, `name`,
  `description`, `product_url`, `highlights`) and an availability entry missing any mapped field
  (`warehouse_id`, `warehouse`, `address`, `phone`, `opening_hours`, `status`, `stock`) each still
  produce `UPSTREAM_INVALID_RESPONSE`; a response missing `manufacturer`, missing `status_text`, or
  missing both maps successfully; a wrongly typed `manufacturer` or `status_text` is still rejected;
- configuration, added in review: the timeout defaults to 8000 ms, an empty variable falls back to
  the default, an explicit override is honoured, a malformed value fails loudly rather than silently
  defaulting, and a configuration error names the missing variable without revealing the API key;
- correlation input, added in review: `x-request-id` is ignored and a fresh ID generated; a present
  but blank `x-correlation-id` also yields a generated ID;
- latency metrics, added in review: both figures appear on the completion line when upstream was
  called; `requestLatencyMs` is never smaller than `upstreamLatencyMs`; the completion line and the
  upstream line agree on the upstream figure; `upstreamLatencyMs` is absent for an `INVALID_REQUEST`
  and for an unknown route; it is still reported when the upstream call fails and when the upstream
  response fails schema validation;
- request validation: empty, whitespace-only, and over-length `q`; `limit` values `abc`, `1.5`, `0`,
  `-1`, `6`, `100`; `limit` 1 and 5 accepted; omitted `limit` sends 5 explicitly; invalid input makes
  no upstream call, asserted by an empty fetch-call list;
- responses and errors: no-match `200` with `resultCount: 0`; empty availability as `[]`; every error
  code's status and retryable flag; no upstream body text or status code in any internal response;
  no API key or raw upstream body in any log line; unknown route returns the `404` envelope with a
  correlation ID.

### A flaky test found and fixed during this pass

Repeated runs surfaced a test that failed roughly one run in twelve: "maps upstream 500 to
UPSTREAM_UNAVAILABLE with status 502". The cause was in the test, not the route. The assertion that
an upstream status code never appears in the internal response serialized the whole error envelope,
including `correlationId` — a random UUID whose hex digits contain the substring `500` or `400` by
chance about 0.7% of the time. `correlationId` is now excluded from that substring check and asserted
separately. The route's behavior was never wrong.

This was found only because the suite was run 12 times in a row; a single green run would have hidden
it. The suite has since passed 25 consecutive runs.

### Manual verification

The compiled build was started and exercised with `curl`, once before the review fixes and again
after them. The post-fix run:

- `GET /health` → `200`;
- unknown route → `404` with the `NOT_FOUND` envelope and a generated correlation ID;
- `limit=99` and missing `q` → `400` `INVALID_REQUEST`, no upstream call;
- inbound `x-correlation-id: review-check-1` → echoed verbatim in the response header;
- inbound `x-request-id: should-be-ignored` → **ignored**; a fresh UUID was generated and returned;
- a real call to the dev upstream with `q=senf&limit=2` → `200`, two correctly mapped products,
  `status: "in_stock"`, verbatim `priceText`;
- a real article-number query `q=209567&limit=1` → `200`, `sku: "209567"`, `priceText: "34,90 €"`;
- a real no-match query → `200`, `resultCount: 0`, `products: []`;
- a real unknown `warehouseId` → `200`, product returned, `availability: []`,
  `warehouseFilterApplied: true`, no reason code.

Latency observed in the post-fix run: cold upstream call **3083 ms**, warm calls **282, 352, and
487 ms**, all well inside the new 8-second timeout. The cold-start effect therefore reproduces; its
magnitude differs from the pre-fix run's 4431 ms.

A third run, after the latency-metric split, confirmed both figures against the real upstream:

| Request                   | `requestLatencyMs` | `upstreamLatencyMs` |
| ------------------------- | ------------------ | ------------------- |
| `q=senf&limit=2` (cold)   | 4591               | 4575                |
| `q=senf&limit=1` (warm)   | 497                | 495                 |
| `q=` → `INVALID_REQUEST`  | 1                  | absent              |
| `/api/nope` → `NOT_FOUND` | 1                  | absent              |
| `/health`                 | 1                  | absent              |

The completion line and the upstream line agreed on `upstreamLatencyMs` in both successful requests,
`upstreamLatencyMs` was absent wherever no upstream call was made, and backend overhead was 16 ms
cold and 2 ms warm. A third cold-start sample of 4575 ms also lands in the same range as the earlier
two, so the cold-start effect is now observed three times across three runs.

The server log was then searched for the API key, the string `x-api-key`, and upstream body content.
All three had zero occurrences in both runs.

## Assumptions

- `manufacturer` and `status_text` are modelled as **optional** strings in the raw upstream schema.
  Neither is part of the public contract, so their absence must not fail a response the backend can
  still answer correctly. When present, both are still type-checked, so a type change remains visible
  while absence is tolerated. Corrected in review; see `D-016`.
- Every field that **is** mapped into the public contract remains required and strictly typed, so a
  missing `price`, `sku`, `name`, `description`, `product_url`, `highlights`, or any mapped
  availability field still rejects the whole response as `UPSTREAM_INVALID_RESPONSE`.
- `priceText`, `description`, `productUrl`, `address`, and `phone` are accepted as `string | null`,
  matching the internal contract types. They were observed only as strings; `null` is accepted rather
  than rejected because the contract already types them nullable.
- `stock` is accepted as `number | null` for the same reason. Only numbers were observed.
- A connection failure and a timeout are both mapped to `UPSTREAM_TIMEOUT`. The contract's trigger
  for that code explicitly covers both.
- Upstream `401` is mapped to `UPSTREAM_AUTH_FAILED` alongside the observed `403`. Only `403` was
  observed; `401` is defensive and follows the same reasoning.
- Unknown query parameters are ignored rather than rejected. The contract does not require rejecting
  them, and the removed `mode` and `storeId` fields would otherwise turn into caller errors.

## Limitations

- **The upstream timeout is now 8 seconds, and the cold-start cost it exists to absorb is real but
  only coarsely characterized.** Two measurement runs against the dev upstream, each from one client
  on one network:
  - run 1 (pre-fix): cold **4431 ms**; warm 316, 472, 476 ms;
  - run 2 (post-fix): cold **3083 ms**; warm 282, 352, 487 ms.

  The cold call reproduces, but its magnitude varies by more than a second between runs. Eight
  samples total is not a latency profile, and no percentile claim should be made from it.

- **The 8-second timeout governs `upstreamLatencyMs`, not `requestLatencyMs`.** It bounds the
  `fetch` call alone. Body download, schema validation, and mapping run after that measurement stops,
  so total request duration can exceed 8 seconds without the timeout firing. Both figures are now
  logged, so the distinction is visible rather than implicit — but **no end-to-end latency budget
  exists**, and nothing currently bounds `requestLatencyMs`. Defining and enforcing one is
  outstanding work.
- **A correction to an earlier figure in this report.** A previous draft reported a roughly
  1.2-second gap between upstream time and end-to-end time, inferred by comparing a `curl` client-side
  total against a server-side log line. That comparison was invalid: it folded client connection setup
  into what was read as backend time. With both metrics now measured inside the same request, backend
  overhead is **16 ms cold and 2 ms warm**. The latency split was still worth making — the timeout
  governs only one of the two quantities — but it did not reveal hidden backend cost, and the earlier
  1.2-second figure should not be cited.
- No retry, no backoff, and no circuit breaker, deliberately. A `UPSTREAM_TIMEOUT` or
  `UPSTREAM_UNAVAILABLE` is reported as retryable and the decision to retry is left to the consumer.
- No rate limiting on the public route. `architecture.md` requires it for public traffic; the route is
  not yet publicly reachable, and deployment is Phase 7.
- The unknown-warehouse ambiguity is unresolved by design. `availability: []` still means only that no
  entries were returned. This is Phase 1 architecture-review finding 4 and resolves in Phase 4.
- The contract test asserts against a single stored sample containing a single warehouse and only the
  `AVAILABLE` status. No redacted sample of an `OUT_OF_STOCK` response or a multi-warehouse response
  exists, so those paths are covered by handwritten fixtures rather than by observed evidence.
- The search term `q` is deliberately not logged, so a caller-reported bad result cannot be traced to
  the exact term they used. This trades debuggability for keeping spoken caller input out of logs.

## Unresolved questions

1. Is the cold-start cost a property of the dev environment only, or will it also appear in the
   environment Dialfire eventually calls? The 8-second timeout was chosen against dev measurements
   alone. This needs re-measuring against the target environment before Phase 7 deployment, and 8
   seconds is still a long silence on a voice call if a cold start is common there.
2. Should a cold-start mitigation other than a longer timeout be considered later — a scheduled
   warm-up ping, or a connection kept alive? No retry was added, per the review instruction, and none
   should be added without deciding this question first.
3. Should `UPSTREAM_REJECTED_REQUEST`, documented as a backend defect rather than a caller error,
   raise an alert rather than only a log line once monitoring exists in Phase 16?
4. What should bound total request duration? The timeout covers the upstream call only, and
   `requestLatencyMs` is now measured but not limited. A voice caller experiences the total, not the
   upstream portion, so a budget against `requestLatencyMs` is the one that matters for the call
   experience.

Four questions from earlier drafts of this report are now closed: the timeout value is decided at
8 seconds; `manufacturer`/`status_text` no longer fail a response when absent; only
`x-correlation-id` is accepted; and the ambiguous `latencyMs` field is split into two named metrics.
Closing the last of these turned an unanswered question into a measured, visible quantity — but it
did not add a limit, which is why question 4 above replaces it.

## Documentation changes

The Phase 2 contract was implementable as written. The three review corrections then required
documentation updates, all of them recording decisions rather than changing observed evidence:

- `docs/api-contracts.md` — the timeout section rewritten: 8 seconds, configurable, with the measured
  latency recorded as `[E]` and the raise as `[D]`; the correlation-ID section now names
  `x-correlation-id` as the only accepted inbound header and documents the sanitization rule; the
  upstream-validation section now states that `manufacturer` and `status_text` are optional, with the
  reasoning for why the strictness rule does not extend to fields no consumer reads.
- `docs/project-decisions.md` — `D-016` added, covering the first three corrections; `D-017` added,
  covering the latency-metric split and stating that the timeout governs the upstream call only.
- `docs/api-contracts.md` — a "Latency metrics" subsection added under Logging, defining both fields,
  when each is present, and what the timeout does and does not bound.
- `.env.example` — `MANUFACTUM_API_TIMEOUT_MS` added and documented as optional.

`docs/phase-2-implementation-report.md` was deliberately **not** edited. It is a historical record of
what Phase 2 decided with the evidence it had, and its open question about the 5-second timeout is
answered here rather than rewritten there.

## Recommendation

Ready for architecture and acceptance review.

Phase 3 is not declared accepted here. Before acceptance, the timeout question above should be
decided, because it is the one finding that can make a correctly implemented route fail on a live
call.

Once accepted, the next phase is Phase 4 — Store Resolution, which also closes the unknown-warehouse
ambiguity that Phase 3 deliberately leaves open.
