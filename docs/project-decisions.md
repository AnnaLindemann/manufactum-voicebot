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

## D-011-RAG — Test embedding runtime: local Transformers.js on Render

Accepted for the RAG embedding test phase.

The embedding model runs locally inside the existing Node.js backend on Render through
Transformers.js. No external embedding API, Hugging Face Endpoint, API key, or paid provider is used
for this test phase.

Profile:

- provider: local Transformers.js;
- model: `Xenova/multilingual-e5-small`;
- artifact: pinned immutable Hugging Face revision and explicit quantized ONNX artifact;
- dimension: 384;
- health endpoint never loads the model;
- no paid embedding provider for the test phase.

Known limitation: Render cold starts and spin-down can require model re-download or reload.

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

## D-016 — Phase 3 review corrections: timeout, upstream strictness, and correlation input

Accepted.

Three corrections were applied to the Phase 3 implementation in review. None of them changes what the
route returns on a successful call.

### Upstream timeout raised from 5 s to 8 s

`api-contracts.md` set 5 seconds in Phase 2 as an explicitly unmeasured decision and required it be
revisited with real latency data in Phase 3. The measurement was taken against the dev upstream: the
cold call took **4431 ms**; warm calls took **316 ms, 472 ms, and 476 ms**. A cold call consumed 89%
of the 5-second budget, so a cold upstream would have intermittently produced `UPSTREAM_TIMEOUT` on a
live call — a correctly implemented route failing for a reason unrelated to the caller's request.

The timeout is now **8 seconds**, held in one place, `DEFAULT_UPSTREAM_TIMEOUT_MS` in
`src/config/manufactum-config.ts`, and overridable per environment through `MANUFACTUM_API_TIMEOUT_MS`
so a slower environment can be tuned without a code change. It is not duplicated as a literal
anywhere else.

No retry, backoff, or warm-up was added. A retry would multiply worst-case latency on exactly the
call that is already slow, which is the wrong trade on a voice call. Whether the cold-start cost is a
property of the dev environment alone is still open and must be measured against the environment
Dialfire eventually calls.

### `manufacturer` and `status_text` no longer fail a response when absent

The first implementation modelled both as required in the raw upstream schema, so upstream dropping
either would have produced `UPSTREAM_INVALID_RESPONSE` for a response the backend could still have
answered correctly. Neither field is part of the public contract, per `D-015`.

The strictness rule protects fields that reach a caller: a price or a stock value spoken wrongly is
worse than a safe failure. That reasoning does not extend to a field no consumer reads. Both fields
are now optional.

They remain modelled rather than removed, because a _type_ change is still a shape change worth
detecting. A `manufacturer` that turns into a number is still rejected; only absence is tolerated.
Every field that **is** mapped into the public contract stays required and strictly typed.

### `x-correlation-id` is the only accepted inbound correlation header

The first implementation also honoured `x-request-id`. Two accepted spellings mean two things a
caller can send and two things an operator must check when tracing a reported failure, for no gain.
`x-request-id` is now ignored; when `x-correlation-id` is absent, empty, or empty after sanitization,
an ID is generated. The response header and the error envelope are unchanged.

## D-017 — Upstream latency and total request latency are logged as two named metrics

Accepted.

Phase 3 originally logged a single `latencyMs`. It was measured around the `fetch` call, so it
covered the Manufactum request only, but its name implied it covered the request. Two things went
wrong as a result:

- an operator reading a log line could not tell backend overhead from upstream time;
- the 8-second upstream timeout and the logged figure looked like they governed the same quantity.
  They do not: the timeout bounds the `fetch` call, while total request duration also includes body
  download, schema validation, mapping, and serialization.

Two explicitly named metrics now replace it:

- `upstreamLatencyMs` — the Manufactum call alone, from issuing the `fetch` until its response
  headers arrive or it fails. This is exactly the span the upstream timeout bounds.
- `requestLatencyMs` — total backend handling, from request entry until the response is completed.
  Logged for every HTTP request, including those that never call upstream.

When an upstream call occurs, both appear on the `request_completed` line, so a single entry shows
the upstream portion and the whole, and their difference is the backend's own overhead. On a request
that made no upstream call, `upstreamLatencyMs` is **absent** rather than zero: a zero would be a
fabricated measurement of something that never happened.

The upstream client reports its timing through a small `RequestContext`
(`src/observability/request-context.ts`) carrying the correlation ID and a latency sink. The context
holds no Express type, so the integration layer still knows nothing about HTTP.

Consequence to keep in view: **the 8-second timeout bounds `upstreamLatencyMs` only.** Body download,
schema validation, and mapping run after that measurement stops, so total request duration can exceed
8 seconds without the timeout firing. Any end-to-end latency budget must be set against
`requestLatencyMs` and enforced separately; none is defined yet.

What the split then showed, once both figures were measured inside the same request: backend overhead
is **small** — 16 ms on a cold call (4591 ms total against 4575 ms upstream) and 2 ms warm (497 against
495). This corrects an earlier claim in the Phase 3 report of a roughly 1.2-second gap. That figure
came from comparing a `curl` client-side total against a server-side log line, which folded client
connection setup into what was read as backend time. The two quantities were never comparable; only
now, measured in the same request, is the real overhead visible. The split remains worthwhile, because
the timeout genuinely governs only one of the two — but it did not uncover hidden backend cost, and
no claim of one should be carried forward.

## D-018 — Test Deployment is a separate checkpoint, protected by a rate limit rather than a token

Accepted.

The Test Deployment is a **separate checkpoint** taken after Phase 3 acceptance. It is not Phase 4,
and it is not Phase 7 pulled forward. This resolves the ordering contradiction recorded as `C-2` in
`deployment-preflight.md`: `roadmap.md` places public test deployment at Phase 7, while
`deployment-strategy.md` § Deployment order places it immediately after one normalized endpoint,
which is where the project stands and which `D-008` supports. Both documents keep their wording; this
decision states that the checkpoint is its own unit of work, so Phase 4 remains the next roadmap
phase and nothing in Phase 7 is considered delivered.

### No shared inbound token

A shared static token on `GET /api/products/search` was considered as the cheapest access control
and **rejected**. Dialfire's secret storage is unconfirmed. A token that has to live in a Dialfire
script is not held securely, and an insecure token is worse than none: it produces the appearance of
access control without the substance, and invites the endpoint to be treated as protected when it is
not. The endpoint is therefore **unauthenticated and read-only** for the duration of the checkpoint,
and that fact is stated plainly rather than papered over.

### Rate limit as the compensating control

Because there is no inbound authentication, the rate limit is the only control standing between the
public URL and our upstream Manufactum credential. Agreed policy: **20 requests per minute per client
IP** on `GET /api/products/search`, with `GET /health` exempt so platform probes cannot be rejected.

This closes `C-1` in `deployment-preflight.md`, where `architecture.md` § Security rules required
public endpoints to be rate-limited and no limiter existed.

Properties deliberately accepted for a demo-scale deployment, each recorded in `api-contracts.md`
§ Rate limiting: a fixed rather than sliding window; a code constant rather than an environment
variable; and in-memory per-process counting, which requires the Test Deployment to run a single
instance. A shared counter is a Phase 16 concern.

No third-party rate-limiting dependency was added. The implementation is a small fixed-window
counter, which keeps the dependency surface of a publicly reachable service unchanged.

### `RATE_LIMITED` and the internal status set

`RATE_LIMITED` is added to the error table with HTTP `429` and `retryable: true`. It is the only code
that waiting alone resolves, and the response carries `Retry-After` in whole seconds. The internal
status set widens from `{200, 400, 404, 500, 502, 504}` to include `429`. The set remains closed, and
the rule that no upstream status is ever forwarded is unchanged: `429` is generated internally and
has no upstream counterpart.

### Fail-fast startup configuration check

`src/server.ts` validates the Manufactum configuration once at startup and exits non-zero when it is
missing or malformed. This closes `C-6` in `deployment-preflight.md`.

The configuration is still read lazily in the request path, and that stays deliberate: importing the
app for a test or a health check must not require credentials. But on a deployment the laziness hid a
real failure — a release with missing variables booted, answered `GET /health` with `200`, was
reported healthy by the platform, and failed only when the first caller received an `INTERNAL_ERROR`.
A misconfigured release must fail at deploy time, while rollback is still the obvious response.

The check calls the same loader the client uses, so there is no second definition of validity to
drift. Its message names the missing variables and never their values.

### `TRUST_PROXY`

The limiter counts against `request.ip`, which resolves to the socket peer unless Express's
`trust proxy` is enabled. `TRUST_PROXY` is optional and **off by default**, because the two failure
directions are not symmetric: off behind a real proxy makes every caller share one bucket, which is
stricter than intended and fails safe; on where no proxy sets `X-Forwarded-For` lets any caller forge
a fresh identity per request and bypass the limiter entirely. It must be set once the deployment
topology is known.
