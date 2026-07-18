# Phase 2 Implementation Report

## Phase

Phase 2 — Internal API Contracts.

## Summary

Phase 2 recorded the agreed MVP internal contract for the future `GET /api/products/search` route and
brought the surrounding documentation into agreement with it.

This is a **documentation-only** phase. No route, schema code, upstream client, middleware, or test
was created. No file under `src/`, `scripts/`, or `tests/` was touched.

The contract is derived exclusively from Phase 1 observations. Every statement in it is tagged `[E]`
for observed upstream evidence or `[D]` for an intentional internal decision, so a reader can tell
what upstream actually does from what this project chose.

## Scope

- Included:
  - the MVP contract for `GET /api/products/search`: request fields, response models, status mapping,
    upstream-validation rule, no-results behavior, empty-availability behavior, error contract,
    mapping boundaries, and deliberate exclusions;
  - explicit `[E]` / `[D]` tagging throughout the contract;
  - restatement of `D-012` so its trigger names the phase that actually introduces the first route;
  - two new decisions, `D-014` (Phase 2 is documentation-only) and `D-015` (deliberate MVP narrowing);
  - consistency updates to the domain model, architecture, roadmap, test strategy, review checklist,
    and capability status.

- Explicitly excluded:
  - any route, controller, service, client, schema code, mapper, or middleware;
  - correlation logging, error middleware, and the 404 handler, which move to Phase 3 with the route;
  - any test;
  - contracts for reservations, store resolution, alternatives, online availability, categories,
    variants, or RAG, none of which has an observed upstream capability;
  - Dialfire configuration, deployment, database, and API keys.

## Files changed

- `docs/api-contracts.md` — rewritten. The provisional search contract was replaced by the agreed MVP
  contract. The sketched request and response shapes for `/api/stores/resolve`, `/api/reservations`,
  and `/api/rag/query` were removed and those endpoints listed as provisional, out-of-scope roadmap
  intent.
- `docs/domain-model.md` — scope note added; `Product.price` replaced by `priceText`; MVP-difference
  sections added to `Product` and `Availability`.
- `docs/project-decisions.md` — `D-012` restated; `D-014` and `D-015` added.
- `docs/roadmap.md` — Phase 2 marked documentation-only with an acceptance gate; Phase 3 expanded to
  own the first route and the `D-012` requirements.
- `docs/architecture.md` — `correlationId` added to the envelope example; failure-policy rules and the
  Phase 3 implementation pointer added.
- `docs/test-strategy.md` — price-parsing unit test removed; product-search test list added for Phase 3.
- `docs/review-checklist.md` — the provisional-contracts question replaced with evidence-traceability
  questions.
- `docs/bot-capabilities.md` — current status corrected from Phase 0 to Phase 2.
- `docs/phase-2-implementation-report.md` — this report.

No files under `src/`, `scripts/`, or `tests/` were changed.

## Functionality added

None. Phase 2 adds no runtime behavior. Its deliverable is a documented contract.

## Contract recorded

- **Request.** `q` required, trimmed, 1–200 characters. `warehouseId` optional, trimmed, opaque, 1–64
  characters. `limit` optional integer, default 5, minimum 1, maximum 5. Invalid input becomes
  `INVALID_REQUEST` and never reaches upstream.
- **Response.** Top level `query`, `resultCount`, `warehouseFilterApplied`, `products`. Product:
  `sku`, `name`, `priceText`, `description`, `highlights`, `productUrl`, `availability`. Availability:
  `warehouseId`, `warehouseName`, `address`, `phone`, `openingHours`, `status`, `stock`.
- **Excluded.** No numeric price parsing, no `manufacturer`, no upstream `status_text`, no `checkedAt`,
  no reason code on empty availability, no ambiguity or exact-match claim.
- **Status mapping.** `AVAILABLE` to `in_stock`; `OUT_OF_STOCK` to `out_of_stock`; any unexpected
  status to `unknown`, logged with its raw value and never spoken as stock information.
- **Upstream validation.** Every upstream field mapped into the public contract must be present with
  its observed type, or the whole response is rejected as `UPSTREAM_INVALID_RESPONSE`. No partially
  populated product is emitted.
- **Empty availability.** Never means out of stock. It means only that no availability entries were
  returned.
- **Errors.** `INVALID_REQUEST` 400, `UPSTREAM_AUTH_FAILED` 502, `UPSTREAM_TIMEOUT` 504,
  `UPSTREAM_INVALID_RESPONSE` 502, `UPSTREAM_REJECTED_REQUEST` 502, `UPSTREAM_UNAVAILABLE` 502,
  `INTERNAL_ERROR` 500, `NOT_FOUND` 404. Upstream status codes and upstream error bodies are never
  forwarded to Dialfire.

## Evidence versus decisions

The contract separates the two explicitly. The distinction that most needed stating:

- **Observed `[E]`:** upstream requires `q`; upstream rejects a non-integer `limit`; upstream returns
  `403` with `{"message":"Forbidden"}` without a key; a no-match query returns `200` with an empty
  product list; an unknown warehouse returns `200` with an empty availability array; `price` is a
  localized string; `status` values `AVAILABLE` and `OUT_OF_STOCK`.
- **Decided `[D]`:** the 1–5 `limit` window; the 200-character `q` ceiling; the 5-second timeout; every
  field exclusion; the `unknown` status fallback; mapping upstream `403` to an internal `502`; the
  rule that upstream bodies and status codes are never forwarded.

**Timeout handling and invalid/non-JSON upstream response handling are `[D]` defensive behavior, not
observed facts.** No upstream timeout and no malformed upstream response occurred during Phase 1.
Those code paths will exist because the backend must not fail unsafely, not because upstream was seen
to behave that way. The contract states this in its evidence-notation section so that no future reader
cites `UPSTREAM_TIMEOUT` or `UPSTREAM_INVALID_RESPONSE` as evidence of upstream behavior.

## Phase boundary and D-012

`D-012` deferred the structured error envelope and correlation logging, with the trigger "the same
phase that introduces the first API route", and named Phase 2 parenthetically on the assumption that
the route would appear there.

That assumption did not hold. `D-014` establishes Phase 2 as documentation-only, so the trigger is now
stated consistently against **Phase 3**, which introduces the route.

The trigger itself did not change — it has always been the phase that introduces the first API route.
Only the phase number satisfying it moved, because the route moved. The requirement is also tightened:
the envelope, correlation logging, error middleware, and 404 handler must be in place **before** the
Phase 3 route returns real product data.

Phase 3 therefore owns, as one unit: the route, the upstream client, request and response schemas, the
mapper, correlation-ID logging, the Express error middleware, the 404 handler, and all tests. Splitting
a route from its error handling would ship a route whose failures fall through to the Express default
handler, which is the risk `D-012` exists to close.

## Checks and tests run

| Check                          | Result                      |
| ------------------------------ | --------------------------- |
| `git diff --check`             | Pass — no whitespace errors |
| `npm run typecheck`            | Pass                        |
| `npm run lint`                 | Pass                        |
| `npm run format:check`         | Pass                        |
| `npm test` (vitest)            | Pass — 1 test file, 1 test  |
| `npm run build`                | Pass                        |
| `npm run check` (all of above) | Pass — exit code 0          |

`npm run check` passing carries limited meaning this phase. No source file changed, so the checks
confirm only that the repository is unchanged and still green — they validate nothing about the
contract. The contract's correctness is established by review against `api-observation-report.md`, not
by a passing build.

## Assumptions

- The Phase 1 observations remain an accurate description of upstream behavior. They were recorded
  against the development environment on a single day and are not a stability guarantee.
- The observed response shape is representative enough to contract against. Phase 1 explicitly did not
  establish that it is stable.
- A voice caller is best served by at most five results. This drives the `limit` maximum and is a
  conversation-design judgement, not a measured finding.

## Limitations

- The contract is unexecuted. No parser, route, or test has exercised it, so it has been validated by
  reading rather than by running.
- An unknown warehouse still cannot be distinguished from a warehouse with no stock. The contract
  handles this by refusing to claim either, which is honest but leaves a real customer question
  unanswerable until the Phase 4 store registry.
- The 5-second upstream timeout is unmeasured. Phase 1 collected no latency data.
- The upstream maximum `limit` remains unknown. The internal maximum of 5 sidesteps rather than
  resolves this.
- Only `GET /search` has ever been observed, so this contract covers the entire confirmed upstream
  surface. Any later endpoint requires its own discovery.

## Unresolved questions

- Should an upstream authentication failure surface as a generic `502`, or as a distinct code that
  Dialfire routes straight to human transfer? The latter leaks less to the caller but requires
  agreeing the transfer trigger ahead of Phase 8.
- Is the 5-second timeout correct? It should be revisited with real latency data during Phase 3.
- Should the client's API team be asked to distinguish an unknown warehouse from an empty result
  upstream, rather than waiting for the Phase 4 store registry to work around it?
- Does `GET /api/products/search` need authentication of its own? It becomes publicly reachable at
  Phase 7 and proxies a credentialed upstream. Better decided before deployment than at it.
- Is the observed product-response structure stable across products and over time? Carried forward
  unresolved from Phase 1.

## Documentation updates

Listed under "Files changed". The substantive changes are the rewritten `api-contracts.md`, the
restated `D-012`, and the new `D-014` and `D-015`.

Two documents were corrected because they had drifted rather than because Phase 2 changed them:
`review-checklist.md` asked whether contracts were "still marked provisional until discovery is
complete", which no longer parses now that discovery is complete and a contract is agreed; and
`bot-capabilities.md` still reported Phase 0 as the current status after Phase 1 had been accepted.

## Evaluation

Per `evaluation-framework.md`, this section is the phase's evaluation record.

| Level                            | Result         | Reason                                                                                                                  |
| -------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Level 1 — Technical Validation   | PASS           | `npm run check` passes in full. Scoped to the repository being unchanged and green; no new behavior exists to validate. |
| Level 2 — Information Validation | Not applicable | No customer-facing answer surface exists; nothing produces information yet.                                             |
| Level 3 — Conversation           | Not applicable | No Dialfire integration and no conversation layer exist.                                                                |
| Level 4 — Task Success           | Not applicable | No customer task can be completed; there is no backend route.                                                           |
| Level 5 — Customer Experience    | Not applicable | No customer interaction exists.                                                                                         |
| Level 6 — Cost Validation        | Not applicable | No LLM calls and no per-conversation cost surface exist.                                                                |
| Level 7 — Performance            | Not applicable | No backend request path exists to measure.                                                                              |
| Level 8 — RAG Validation         | Not applicable | RAG is not implemented; it begins at Phase 10.                                                                          |

Level 1 asserts nothing about the contract being correct or implementable. A documentation-only phase
cannot be validated by its build.

## Architecture review

1. **The contract's central risk is that it is unexecuted.** Every previous phase produced something
   runnable. This one produced a specification that no parser has consumed. The first real test of it
   is Phase 3, and the most likely discovery there is that some upstream field is optional in
   responses beyond the single stored sample — which the strict-rejection rule would turn into a hard
   `UPSTREAM_INVALID_RESPONSE`. Phase 3 should verify field presence across more than one product
   before finalizing the strict rule.
2. **Strict upstream rejection is deliberately aggressive.** Rejecting a whole response over one
   missing field will produce failures where a lenient parser would have produced a partial answer.
   This is the correct trade for a voice bot quoting prices and stock, but it should be a conscious,
   revisitable choice rather than an accident, and it is recorded as `[D]`.
3. **`unknown` status is the one tolerance in an otherwise strict mapping.** The inconsistency is
   intentional: a single unrecognized status must not blank out a valid product. The obligation never
   to speak it as stock information is stated in the contract, but nothing enforces it until a
   consumer exists in Phase 8.
4. **Removing the empty-availability reason code is a genuine improvement in honesty and a genuine
   loss in usability.** The bot can now say less about a store it cannot identify. That is the right
   default, but it makes the Phase 4 store registry more urgent than the roadmap ordering implies.
5. **No secret, key, or personal datum appears in any changed file.** The changes are documentation
   only, and the contract deliberately forbids logging the API key, the `x-api-key` value, and full
   upstream bodies.

## Recommendation

Ready for independent architecture and acceptance review.

Phase 2 is not declared accepted here. Acceptance requires explicit user acceptance after review.

Once accepted, the next step is Phase 3 — Product Search, Price, and Availability, which introduces
the first API route and must carry the `D-012` requirements in full: the structured error envelope,
correlation-ID logging, the Express error middleware, and the 404 handler, all in place before the
route returns real product data.
