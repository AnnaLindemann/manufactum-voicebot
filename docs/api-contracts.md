# Internal API Contracts

## Status

The MVP product-search contract below is **agreed** and derived from completed Phase 1 discovery.

All other endpoints in this document remain **provisional** and out of MVP scope. They are retained
as roadmap intent only. No contract for them may be designed until the corresponding upstream
capability has been observed, per `D-011`.

## Evidence notation

Every statement in the MVP contract is tagged by its basis.

| Tag   | Meaning                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `[E]` | Observed upstream evidence, recorded in `api-observation-report.md` and traceable to an experiment in `api-discovery-log.md`. |
| `[D]` | An intentional internal decision. Ours, not upstream's. Not evidence of upstream behavior.                                    |

The distinction is load-bearing. An `[E]` statement may be relied on when writing a parser. A `[D]`
statement may be changed by decision without new discovery, and must never be cited as upstream
behavior.

Timeout handling and invalid/non-JSON upstream response handling are `[D]` defensive behavior. No
upstream timeout and no malformed upstream response were ever observed during Phase 1. Those code
paths exist because the backend must not fail unsafely, not because upstream was seen to do this.

---

## GET /health

Returns service status. Implemented in Phase 0. Unchanged by this contract.

---

## GET /api/products/search

The single internal endpoint of the MVP.

`[E]` Exactly one upstream endpoint has been observed: `GET /search`, authenticated with an
`x-api-key` request header.

`[D]` One internal route is defined per observed upstream capability. Nothing else is contracted.

`[D]` This route does not exist yet. Phase 2 defines this contract as documentation only. The route,
the upstream client, and its tests are built in Phase 3. See "Phase boundary" below.

### Request

| Field         | Type    | Required | Rule                                                           | Basis                                                                                     |
| ------------- | ------- | -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `q`           | string  | yes      | trimmed; length 1–200 after trimming; whitespace-only rejected | `[E]` empty `q` is rejected upstream (EXP-011); `[D]` the 200 ceiling is ours             |
| `warehouseId` | string  | no       | trimmed; length 1–64; opaque, no format validation             | `[E]` two identifier formats accepted (EXP-005); unknown values do not error (EXP-006)    |
| `limit`       | integer | no       | integer; minimum 1; maximum 5; default 5                       | `[E]` a non-integer is rejected upstream (EXP-017); `[D]` the 1–5 window is entirely ours |

#### Observed upstream `limit` behavior

`[E]` Omitting `limit` returned five results (EXP-020). `limit=1`, `limit=2`, and `limit=10` returned
that many results (EXP-007, EXP-002, EXP-018). `limit=100` returned eleven results, the full observed
match set, so **no upstream maximum was established** (EXP-019). `limit=0` and `limit=-1` each
returned one result (EXP-008, EXP-009); the upstream normalization rule for those values is
undocumented and unexplained.

#### Internal `limit` decision

`[D]` The internal accepted range is 1–5, default 5. Values of `0`, negative numbers, and values
above 5 are rejected locally as `INVALID_REQUEST`.

`[D]` Consequence: the undocumented upstream normalization of `0` and negative values is unreachable
by design. The backend does not depend on upstream behavior it cannot explain.

`[D]` Rationale for the maximum of 5: a voice caller cannot absorb more than a handful of spoken
products. This is a conversation-design constraint, not an upstream constraint.

`[D]` `limit` is always sent explicitly upstream, including at its default, so the internal result
count never depends on an unobserved upstream default.

#### Validation boundary

`[D]` All request validation happens at the internal boundary, before any upstream call. Invalid
input becomes `INVALID_REQUEST` and **never reaches upstream**. The backend does not use upstream as
a validator.

`[D]` `warehouseId` is passed through verbatim as the upstream `warehouse` parameter. No phone-number
normalization is performed in the MVP; that belongs to the store registry in Phase 4.

#### Fields removed from the earlier provisional contract

`[D]` `mode` — no upstream counterpart was observed.
`[D]` `storeId` — implies a store registry, which does not exist.

### Response — success

HTTP `200`.

```json
{
  "query": "senf",
  "resultCount": 2,
  "warehouseFilterApplied": true,
  "products": []
}
```

| Field                    | Type        | Basis | Meaning                                                                                                                                 |
| ------------------------ | ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                  | string      | `[E]` | Observed upstream `query`.                                                                                                              |
| `resultCount`            | number      | `[E]` | Observed upstream `result_count`.                                                                                                       |
| `warehouseFilterApplied` | boolean     | `[D]` | Records only whether a `warehouseId` was supplied and therefore sent upstream. It asserts nothing about whether upstream recognized it. |
| `products`               | `Product[]` | `[E]` | Observed upstream `products`.                                                                                                           |

#### Product

```ts
type Product = {
  sku: string;
  name: string;
  priceText: string | null;
  description: string | null;
  highlights: string[];
  productUrl: string | null;
  availability: Availability[];
};
```

| Field          | Upstream source          | Basis | Notes                                                     |
| -------------- | ------------------------ | ----- | --------------------------------------------------------- |
| `sku`          | `sku`                    | `[E]` | String even for numeric article numbers, e.g. `"209567"`. |
| `name`         | `name`                   | `[E]` |                                                           |
| `priceText`    | `price`                  | `[E]` | Verbatim localized string, e.g. `"11,90 €"`.              |
| `description`  | `description`            | `[E]` |                                                           |
| `highlights`   | `highlights`             | `[E]` | Array of strings; `[]` when absent.                       |
| `productUrl`   | `product_url`            | `[E]` |                                                           |
| `availability` | `warehouse_availability` | `[E]` | `[]` when no entries are returned.                        |

#### Availability

```ts
type Availability = {
  warehouseId: string;
  warehouseName: string;
  address: string | null;
  phone: string | null;
  openingHours: Record<string, string>;
  status: "in_stock" | "out_of_stock" | "unknown";
  stock: number | null;
};
```

| Field           | Upstream source | Basis | Notes                                                      |
| --------------- | --------------- | ----- | ---------------------------------------------------------- |
| `warehouseId`   | `warehouse_id`  | `[E]` | e.g. `"MANUFACTUM_BERLIN_HAUS_HADENBERG"`.                 |
| `warehouseName` | `warehouse`     | `[E]` | e.g. `"Manufactum Berlin"`.                                |
| `address`       | `address`       | `[E]` |                                                            |
| `phone`         | `phone`         | `[E]` |                                                            |
| `openingHours`  | `opening_hours` | `[E]` | Object keyed by German weekday names, values verbatim.     |
| `status`        | `status`        | `[E]` | Mapped to a closed internal set; see below.                |
| `stock`         | `stock`         | `[E]` | Number; observed values include positive integers and `0`. |

### Fields deliberately excluded from the MVP response

#### Observed upstream, intentionally not exposed

`[D]` `manufacturer` — observed and available, but not required to answer an MVP product-search
question. Every exposed field is a field the contract must then keep stable.

`[D]` `status_text` — upstream-controlled free text, e.g. `"Verfügbar"`. Exposing it would let an
upstream wording change flow directly into a spoken answer with no schema check. Consumers derive
their wording from the closed `status` enum instead.

`[D]` A numeric price. `price` has been observed in exactly one format. Parsing it into an amount and
a currency would invent structure from a single observation, and a mis-parse would make the bot speak
a wrong price — the failure mode `test-strategy.md` places first among its acceptance criteria. Only
`priceText` is returned, and consumers speak it verbatim.

#### Internal, intentionally not present

`[D]` `checkedAt` — response freshness is inherently request-time. The field added no information a
consumer could act on and implied caching semantics that do not exist. Request timing remains in the
correlation logs, where latency is already recorded.

`[D]` `ambiguity` and any exact-match claim. `[E]` An exact product-name query returned two related
variants (EXP-013); a single-character typo returned the same two products in a different order
(EXP-014); an umlaut query and its transliteration returned the same pair (EXP-015, EXP-016).
Therefore `[D]` result order is not treated as stable, `products[0]` is not authoritative, and the
MVP returns the ranked list as received while making no exactness claim.

`[D]` `onlineAvailabilitySupported` — would hardcode a claim about a capability observed neither way.

`[D]` `selectedStore` — requires the store registry, which does not exist.

#### No evidence exists

`[E]` Not observed, therefore treated as unsupported per `D-011`: online-shop availability,
alternatives, categories, variants, product images, pagination, and rate-limit behavior. No field is
contracted for any of them.

### Status mapping

| Upstream `status` | Internal `status` | Basis                           |
| ----------------- | ----------------- | ------------------------------- |
| `AVAILABLE`       | `in_stock`        | `[E]` observed                  |
| `OUT_OF_STOCK`    | `out_of_stock`    | `[E]` observed, with `stock: 0` |
| any other value   | `unknown`         | `[D]` defensive                 |

`[D]` `unknown` is a deliberate defensive mapping. No observed upstream value produces it. It exists
so that an unrecognized future status degrades a single availability entry instead of failing an
entire response or, worse, being silently coerced into `in_stock`.

`[D]` When `unknown` is produced:

- the raw upstream status value is logged together with the correlation ID;
- the entry is still returned, with `stock` carried through unchanged;
- `unknown` **must never be spoken as stock information**. It means "availability could not be
  interpreted". It does not mean available, and it does not mean unavailable. A consumer encountering
  it must ask for clarification or escalate, never assert a stock state.

`[D]` `low_stock`, which appears in `domain-model.md`, is not part of the MVP mapping. No observed
upstream value produces it.

### Upstream response validation

`[D]` Every upstream field that is mapped into the public contract must be present and carry its
observed type. If any is missing or of the wrong type, the **entire upstream response is rejected**
as `UPSTREAM_INVALID_RESPONSE`. The backend does not emit a partially populated product.

`[D]` Rationale: a product spoken with a missing or wrongly typed price or stock value is worse than
a safe failure message.

`[D]` The upstream schema is strict about what is consumed and tolerant about what is not. Unknown
additional upstream fields are ignored, so upstream may add fields without breaking the backend.

`[D]` Fields observed upstream but excluded from the public contract (`manufacturer`, `status_text`)
are still modeled in the raw upstream schema, but as **optional**. Their absence must not produce
`UPSTREAM_INVALID_RESPONSE`.

`[D]` Corrected in the Phase 3 review. The first implementation modelled both as required, which
meant upstream dropping a field that no consumer reads would have failed an entire response the
backend could still have answered correctly. The strictness rule exists to protect fields that reach
a caller — a price or a stock value spoken wrongly — and neither of these does.

`[D]` Optional does not mean unvalidated: when either field is present it must still carry its
observed type, so a `manufacturer` that turns into a number is still rejected. A _type_ change stays
visible; only _absence_ is tolerated.

`[D]` The single deliberate exception to strict rejection is an unrecognized `status` value, which
maps to `unknown` rather than failing the response, as described above.

### No results

`[E]` A query with no match returns upstream HTTP `200` with `result_count: 0` and `products: []`
(EXP-010).

`[D]` The internal response is HTTP `200` with `resultCount: 0` and an empty `products` array. This is
a normal outcome, not an error. No error envelope is returned and the status code stays `200`, so a
consumer can distinguish "no products found" from "system failure" by status code alone.

### Empty availability and the unknown-warehouse ambiguity

`[E]` An unknown `warehouse` value returns HTTP `200` with the matching product and
`warehouse_availability: []` (EXP-006).

`[E]` A real warehouse holding no stock also returns availability entries with `status: "OUT_OF_STOCK"`
and `stock: 0` (EXP-015). But an unknown warehouse and a warehouse for which upstream simply returned
nothing are **shape-identical**: both are an empty array.

`[D]` The contract does not attempt to distinguish them. When no availability is returned, the
response carries exactly two signals and no more:

- `warehouseFilterApplied` — whether a `warehouseId` was sent;
- `availability: []` — that no availability entries came back.

`[D]` No reason code or explanatory flag accompanies an empty array. Any such field would dress an
unresolved ambiguity in the language of an explanation, and a consumer would reasonably read it as a
finding.

`[D]` **`availability: []` never means "out of stock."** It means only that no availability entries
were returned. It must not be rendered to a caller as "not in stock at your store" or as any other
stock claim. A consumer that must say something has to ask for clarification or escalate.

`[D]` Out-of-stock is expressed one way only: an availability entry that is actually present and
carries `status: "out_of_stock"`.

This limitation is recorded as Phase 1 architecture-review finding 4. It resolves in Phase 4, when a
store registry can validate a warehouse identifier before the upstream call is made.

---

## Error contract

`[D]` Every non-2xx internal response returns this envelope, defined in `architecture.md`:

```json
{
  "code": "UPSTREAM_TIMEOUT",
  "safeCustomerMessage": "Ich kann das gerade nicht zuverlässig prüfen.",
  "retryable": true,
  "correlationId": "…"
}
```

`[D]` `safeCustomerMessage` is German, short, and speakable. It contains no technical detail, no
upstream body, no URL, and no parameter name. Technical messages exist only in logs.

### Error codes

| Code                        | HTTP | Retryable | Trigger                                                                              | Basis                                                                    |
| --------------------------- | ---- | --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `INVALID_REQUEST`           | 400  | false     | Internal request validation failed. No upstream call is made.                        | `[D]`                                                                    |
| `UPSTREAM_AUTH_FAILED`      | 502  | false     | Upstream rejected authentication.                                                    | `[E]` HTTP `403`, body `{"message":"Forbidden"}` (EXP-001)               |
| `UPSTREAM_TIMEOUT`          | 504  | true      | Upstream did not respond within the internal timeout, or the connection failed.      | `[D]` defensive; never observed                                          |
| `UPSTREAM_INVALID_RESPONSE` | 502  | false     | Upstream body was not valid JSON, or was valid JSON that failed the upstream schema. | `[D]` defensive; never observed                                          |
| `UPSTREAM_REJECTED_REQUEST` | 502  | false     | Upstream returned HTTP `400`.                                                        | `[E]` observed for empty `q` (EXP-011) and non-integer `limit` (EXP-017) |
| `UPSTREAM_UNAVAILABLE`      | 502  | true      | Any other unexpected upstream status.                                                | `[D]` catch-all; never observed                                          |
| `INTERNAL_ERROR`            | 500  | false     | Unhandled internal exception.                                                        | `[D]`                                                                    |
| `NOT_FOUND`                 | 404  | false     | Unknown internal route.                                                              | `[D]`                                                                    |

`[D]` `UPSTREAM_REJECTED_REQUEST` should be unreachable in normal operation, because internal
validation is stricter than the observed upstream validation. If it occurs, the internal request
schema and the upstream contract have diverged, and it is logged as a backend defect rather than a
caller error.

### Error handling rules

`[D]` **Upstream status codes are never forwarded.** The internal status set is fixed at
`{200, 400, 404, 500, 502, 504}`. An upstream `403` becomes an internal `502`, never an internal
`403`: a missing or invalid API key is a backend misconfiguration, not a fault of the caller, and
forwarding `403` would invite Dialfire to treat it as an authorization problem on its own side.

`[D]` **Upstream error bodies are never forwarded.** The observed bodies `{"message":"Forbidden"}` and
`{"error":"Query parameter 'q' is required"}` are logged and never returned. Dialfire never receives
raw technical errors, per `architecture.md`.

`[D]` **Only timeout and `UPSTREAM_UNAVAILABLE` are retryable.** An authentication failure or a schema
violation will not fix itself on retry; marking either retryable would make a voice agent stall on a
call that cannot succeed.

`[D]` Internal upstream request timeout: **8 seconds**, configurable per environment through
`MANUFACTUM_API_TIMEOUT_MS`. This is still tighter than the 10-second timeout used by the Phase 1
discovery script, because a voice call cannot wait indefinitely.

`[E]` The Phase 2 value of 5 seconds was an unmeasured decision, and this contract required it be
revisited with real latency data in Phase 3. That measurement was taken: the **cold** upstream call
took **4431 ms**, while warm calls took **316 ms, 472 ms, and 476 ms**. A cold call therefore
consumed 89% of a 5-second budget.

`[D]` The timeout was raised to 8 seconds so that a cold start has real headroom instead of
intermittently producing `UPSTREAM_TIMEOUT` on a live call. No retry, backoff, or warm-up
accompanies the change: a retry would multiply worst-case latency on exactly the call that is already
slow. See `D-016`.

### Logging

`[D]` Logged per request: correlation ID, endpoint, upstream status, both latency metrics below,
result count, error code, and the raw upstream `status` value whenever it maps to `unknown`.

#### Latency metrics

`[D]` Two distinct measurements are logged, never one ambiguous "latency":

| Field               | Measures                                                                                             | Present when                           |
| ------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `upstreamLatencyMs` | The Manufactum call alone: issuing the `fetch` until its response headers arrive, or until it fails. | An upstream call was made.             |
| `requestLatencyMs`  | Total backend handling: request entry until the response is completed.                               | Every HTTP request, without exception. |

`[D]` When an upstream call occurs both are reported on the `request_completed` line, so one log
entry shows the upstream portion and the whole. Their difference is the backend's own overhead —
body download, schema validation, mapping, and serialization.

`[D]` `upstreamLatencyMs` is **absent**, not zero, on a request that made no upstream call, such as
an `INVALID_REQUEST` rejected at the boundary or an unknown route. A zero would be a fabricated
measurement of something that never happened.

`[D]` **The upstream timeout governs `upstreamLatencyMs`, not `requestLatencyMs`.** The configured
8 seconds bounds the `fetch` call only. Body download, schema validation, and mapping happen after
that measurement stops and are not covered by it, so total request duration can exceed the timeout
without the timeout firing. Any future end-to-end latency budget must be set against
`requestLatencyMs` and enforced separately.

`[D]` This split was introduced by the Phase 3 observability fix. The single `latencyMs` field it
replaces was measured at the upstream call but named as though it covered the request, which made
the logged figure and the timeout look like they governed the same quantity. See `D-017`.

`[D]` Never logged: the API key, the value of the `x-api-key` header, or full upstream response
bodies.

`[D]` The correlation ID is taken from the inbound `x-correlation-id` header when present and
generated otherwise. It is echoed in the response `x-correlation-id` header and in the error envelope
so a customer-reported failure is traceable.

`[D]` `x-correlation-id` is the **only** accepted inbound header. An `x-request-id` was also honoured
in the first Phase 3 draft and was removed in review: two accepted spellings mean two things a caller
can send and two things an operator must check when tracing a reported failure. An inbound value is
trimmed, bounded at 128 characters, and stripped of characters outside `[A-Za-z0-9_.:-]` before it
reaches a log line; a value that is empty after that treatment is replaced by a generated ID.

---

## Mapping boundaries

`[D]` Three layers, per `coding-standards.md` and Phase 1 architecture-review finding 1:

```text
UpstreamSearchResponse   raw, snake_case, mirrors the observed JSON exactly
        ↓ schema validation — on failure, UPSTREAM_INVALID_RESPONSE
        ↓ mapper — pure function, no I/O, no clock
ProductSearchResult      internal, camelCase, closed status enum
        ↓ controller
HTTP response body
```

`[D]` Rules:

1. Raw upstream types live in the products integration layer and never leave it. No raw upstream type
   appears in a route, controller, or application-service signature.
2. The upstream response is validated, never cast. Type assertions on parsed JSON are prohibited.
3. The mapper is total and pure: it does not throw, does not perform I/O, and does not read the clock.
   Removing `checkedAt` from the response removed the mapper's only reason to touch time, so it is now
   deterministic by construction.
4. Nothing is invented. Every field in the public contract traces to an observed upstream field,
   except `warehouseFilterApplied` and `correlationId`, which are internal and documented as `[D]`.

---

## Phase boundary

`[D]` **Phase 2 produces this documented contract and nothing else.** No route, no schema code, no
client, no middleware, and no tests are created in Phase 2. `roadmap.md` defines the Phase 2
deliverable as reviewed API contracts, and Phase 3 as the first working product-search backend.

`[D]` **Phase 3 introduces all of the following together**, because they are the same route's safety
requirements and must not be split across phases:

- the `GET /api/products/search` route, controller, and application service;
- the upstream client and the request and response schemas;
- the mapper;
- correlation-ID request logging;
- the central Express error middleware implementing the envelope above;
- the 404 handler;
- unit, integration, and contract tests.

`[D]` The structured error envelope and correlation logging deferred by `D-012` therefore land in
Phase 3, in the same phase as the first API route and before any real product data is returned. See
`D-012` and `D-014` in `project-decisions.md`.

---

## Provisional — not in MVP scope

The endpoints below are roadmap intent only. None has an observed upstream capability. No contract for
any of them may be designed until discovery proves the capability exists, per `D-011`.

```text
GET    /api/products/:productId
GET    /api/products/:productId/availability
GET    /api/products/:productId/alternatives
GET    /api/stores
GET    /api/stores/resolve
POST   /api/reservations
GET    /api/reservations/:reservationId
DELETE /api/reservations/:reservationId
POST   /api/links/send
POST   /api/rag/query
```

The request and response shapes previously sketched here for `/api/stores/resolve`,
`/api/reservations`, and `/api/rag/query` have been removed. They described no observed capability,
and leaving them in a document that now contains an agreed contract risked their being read as
agreed too. They are recoverable from Git history if a later phase needs them as a starting point.
