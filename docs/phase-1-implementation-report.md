# Phase 1 Implementation Report

## Phase

Phase 1 — External API Discovery.

## Summary

Phase 1 determined what the real Manufactum warehouse search API actually returns, using Postman
experiments and a local TypeScript discovery script. All findings were recorded as observations in
`api-discovery-log.md` and promoted to `api-observation-report.md`. One redacted sample response was
stored. No application code, backend route, or internal contract was implemented.

## Scope

- Included:
  - observed request behavior of `GET /search` (`q`, `warehouse`, `limit`, authentication);
  - observed response structure, product fields, and warehouse-availability fields;
  - observed error and edge-case behavior (missing key, empty `q`, no match, unknown warehouse,
    non-integer `limit`);
  - one redacted sample response produced by the local discovery script;
  - Phase 1 closeout documentation.

- Explicitly excluded:
  - any Phase 2 work (internal API contracts, validation schemas, backend routes);
  - normalization of upstream responses into internal domain models;
  - reservation, store-resolution, alternatives, and RAG endpoints;
  - Dialfire integration and conversation design;
  - deployment, database, and persistence;
  - any change to `api-contracts.md`, which stays provisional per `D-011`.

## Files changed

- `scripts/test-search-api.ts` — local discovery script (added in the Phase 1 discovery commit).
- `docs/api-samples/search-response.redacted.json` — redacted observed sample.
- `docs/api-discovery-log.md` — experiment record; the completed redacted-sample follow-up item was
  removed in this closeout.
- `docs/api-observation-report.md` — status set to completed for the observed scope; the
  unsupported/unknown capabilities section was rewritten to reflect what was actually observed.
- `docs/coding-standards.md` — contradictory phase-branch and merge-rule sections removed; the
  document now consistently states that MVP work happens directly on `main`.
- `docs/roadmap.md` — Phase 0 acceptance-gate wording corrected to remove the Phase 1 branch
  reference.
- `docs/project-decisions.md` — `D-013` resolved.
- `eslint.config.js` — type-aware linting enabled (see `D-013`).
- `tsconfig.check.json` — `scripts` added to `include`, required by type-aware linting and also
  bringing the discovery script under `npm run typecheck`.
- `docs/phase-1-implementation-report.md` — this report.

No files under `src/` were changed. No application code was added or modified in Phase 1.

## Functionality added

- A repeatable local discovery script that reads base URL, API key, and API-key header name from
  environment variables, sends a `GET /search` request with a 10-second abort timeout, prints status
  and formatted JSON, handles non-JSON responses, and writes a key-redacted sample to
  `docs/api-samples/`.
- Type-aware ESLint (`recommendedTypeChecked`) across `**/*.ts`, resolving `D-013`, whose trigger
  was the asynchronous discovery script added in this phase.
- No runtime application functionality was added. Phase 1 is a discovery phase.

### D-013 outcome — type-aware linting

`D-013` deferred the type-aware ESLint decision until asynchronous Phase 1 code existed. That code
now exists, so the evaluation was performed and the decision resolved: **type-aware linting is
enabled.**

- `eslint.config.js` applies `tseslint.configs.recommendedTypeChecked` to `**/*.ts` with
  `parserOptions.project` pointing at `./tsconfig.check.json`.
- `tsconfig.check.json` gained `scripts` in its `include`. Type-aware rules require every linted
  file to belong to a TypeScript project, and `scripts/` belonged to none. This also closes a real
  gap: the discovery script was previously not type-checked by `npm run typecheck` at all.
- Scope was not widened further. The rules are limited to `**/*.ts`, so `eslint.config.js` keeps the
  untyped rule set, and no rules beyond the `recommendedTypeChecked` preset were added.
- No code fixes were needed. `scripts/test-search-api.ts` already ended its promise chain with
  `.catch()`, so `no-floating-promises` had nothing to flag.

Verification that the rules are actually active rather than silently inert:

- `npx eslint --print-config scripts/test-search-api.ts` reports `no-floating-promises`,
  `no-misused-promises`, `no-unsafe-assignment`, and `await-thenable` at severity `error`;
- a temporary probe file containing a deliberately floating promise was linted and failed with
  `@typescript-eslint/no-floating-promises`. The probe was then deleted and is not in the repository.

A passing `npm run lint` alone would not have distinguished "enabled and clean" from "not actually
applying", which is why the probe was run.

## Observed functionality of the external API

- `GET /search` requires `q`; an empty `q` returns HTTP `400` with
  `{"error":"Query parameter 'q' is required"}`.
- Authentication is a `x-api-key` request header. A missing key returns HTTP `403` with
  `{"message":"Forbidden"}`.
- Keyword search (`q=senf`) and article-number search (`q=209567`) both return matching products.
- `warehouse` is optional. Omitting it returned availability for 17 stores in the observed case.
- The observed Berlin warehouse identifier was accepted as both `493024033844` and `+493024033844`.
- An unknown `warehouse` value returned HTTP `200` with the matching product and an empty
  `warehouse_availability` array.
- `limit=1`, `limit=2`, and `limit=10` returned that many results. Omitting `limit` returned five
  results. `limit=100` returned eleven results, the full observed match set. `limit=0` and `limit=-1`
  each returned one result. `limit=abc` returned HTTP `400` with
  `{"error":"Query parameter 'limit' must be an integer"}`.
- A no-match query returned HTTP `200` with `result_count: 0` and `products: []`.
- Response top-level shape: `query`, `result_count`, `products`.
- Product fields: `name`, `sku`, `manufacturer`, `price`, `product_url`, `description`, `highlights`,
  `warehouse_availability`.
- Availability fields: `warehouse_id`, `warehouse`, `address`, `phone`, `opening_hours`, `status`,
  `status_text`, `stock`.
- `price` is a localized string (`"11,90 €"`), `sku` is a string, `opening_hours` is an object keyed
  by German weekday names, `status` values observed were `AVAILABLE` and `OUT_OF_STOCK`, and `stock`
  was `0` in the observed `OUT_OF_STOCK` case.
- An exact product-name query returned two related variants rather than one exact product. A
  single-character typo returned the same two products in a different order. An umlaut query and its
  transliterated form returned the same two results.

## Checks and tests run

| Check                          | Result                                              |
| ------------------------------ | --------------------------------------------------- |
| `npm run typecheck`            | Pass — now also covers `scripts/`                   |
| `npm run lint`                 | Pass — with type-aware rules enabled                |
| ESLint type-aware probe        | Pass — floating-promise probe correctly rejected    |
| `npm run format:check`         | Pass                                                |
| `npm test` (vitest)            | Pass — 1 test file, 1 test                          |
| `npm run build`                | Pass                                                |
| `npm run check` (all of above) | Pass — exit code 0                                  |
| `git diff --check`             | Pass — no whitespace errors                         |
| Manual API verification        | Pass — 22 recorded experiments (EXP-001 to EXP-022) |

No automated test covers the external API. The discovery script is run manually and is not part of
`npm run check`.

## Assumptions

- The observed environment is the Manufactum development warehouse API, not production; observed
  data and behavior may differ in production.
- The stored redacted sample is representative of a successful `q=senf` response at the time it was
  captured, not proof of a stable schema.
- Warehouse identifiers observed for Berlin are assumed to be the store's phone number in two
  formats, based only on the returned `phone` field matching the accepted `warehouse` value.

## Limitations

- Only `GET /search` was exercised. No other upstream endpoint has been confirmed to exist.
- Only one redacted sample response is stored; error responses are recorded as literal bodies in the
  observation report rather than as stored samples.
- The upstream maximum `limit` was not established, because only eleven matching products existed
  for the observed query.
- Search-quality behavior (exact-name, partial-word, typo, umlaut) was observed once each and is not
  a documented guarantee.
- Results were observed manually; no regression test detects an upstream response-shape change.

## Unresolved questions

- Is the observed product-response structure stable across products and over time?
- Does `warehouse` accept identifiers other than the store phone number?
- How should the backend distinguish an unknown warehouse from a real warehouse with no stock, given
  that both return `warehouse_availability: []`?
- What is the upstream normalization rule for `limit=0` and negative values, and what is the maximum?
- Do pagination, rate limits, online availability, alternatives, categories, variants,
  store-resolution, and reservation endpoints exist?

## Documentation updates

- `docs/api-observation-report.md` — status marked completed for the observed Phase 1
  product-search discovery scope; unsupported/unknown capabilities rewritten so that each entry
  reflects an actual gap in evidence rather than a behavior that was in fact observed.
- `docs/api-discovery-log.md` — removed the completed follow-up item about creating the redacted
  sample (done in EXP-012). Unknown external capabilities remain documented as open follow-up.
- `docs/coding-standards.md` — removed the phase-branch and merge-rule sections that contradicted
  the documented MVP decision to work directly on `main`. The rule that commits happen only after an
  accepted phase and an explicit user request is retained.
- `docs/roadmap.md` — the Phase 0 acceptance gate wording "before any Phase 1 branch is opened" was
  corrected to "before Phase 1 work begins", so the roadmap matches the `main`-only MVP workflow.
- `docs/project-decisions.md` — `D-013` changed from a deferred evaluation to a resolved decision
  recording that type-aware linting was enabled, with the rationale and the checks that verified it.
- `docs/phase-1-implementation-report.md` — created from `implementation-report-template.md`.

## Evaluation

Per `evaluation-framework.md`, this section is the phase's evaluation record. No separate Evaluation
Report document exists.

| Level                            | Result         | Reason                                                                       |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Level 1 — Technical Validation   | PASS           | `npm run check` passes in full: typecheck, lint, format check, tests, build. |
| Level 2 — Information Validation | Not applicable | No customer-facing answer surface exists; nothing produces information yet.  |
| Level 3 — Conversation           | Not applicable | No Dialfire integration and no conversation layer exist.                     |
| Level 4 — Task Success           | Not applicable | No customer task can be completed; there is no backend route.                |
| Level 5 — Customer Experience    | Not applicable | No customer interaction exists.                                              |
| Level 6 — Cost Validation        | Not applicable | No LLM calls and no per-conversation cost surface exist.                     |
| Level 7 — Performance            | Not applicable | No backend request path exists to measure end to end.                        |
| Level 8 — RAG Validation         | Not applicable | RAG is not implemented; it begins at Phase 10.                               |

Level 1 is scoped to what Phase 1 actually builds: the project checks and the discovery script. It
does not assert that any API endpoint, Dialfire integration, or error-handling middleware works,
because none exist.

## Architecture review

Findings from reviewing the Phase 1 result against the project's architecture and security rules:

1. **No raw upstream response is exposed by the backend, because no backend route exists yet.** The
   separation between raw upstream types and internal domain models required by `coding-standards.md`
   is therefore untested. It must be established in Phase 2, when the first API route is added.
2. **The API key is environment-based and redacted in the stored sample.** The discovery script reads
   `MANUFACTUM_API_BASE_URL`, `MANUFACTUM_API_KEY`, and `MANUFACTUM_API_KEY_HEADER` from the
   environment and writes `[REDACTED]` in place of the key in the saved sample. No key value appears
   in source, documentation, or the stored sample.
3. **The first search result must not be treated as an exact match in later phases.** An exact
   product-name query returned two related variants, and a typo query returned the same products in a
   different order. Result order is not stable and position one is not authoritative. Phase 3 must
   resolve ambiguity explicitly rather than picking `products[0]`.
4. **An unknown warehouse cannot yet be distinguished from a real warehouse with no stock.** Both
   cases returned HTTP `200` with `warehouse_availability: []`. Until the upstream distinguishes
   them, the backend cannot safely tell a customer "not in stock at your store" versus "we could not
   identify that store". This needs a store registry (Phase 4) or an upstream clarification.
5. **Several capabilities remain unconfirmed and must be treated as unsupported per `D-011`.**
   Pagination, rate limits, online availability, alternatives, categories, variants, store resolution,
   and reservation endpoints have no observed evidence. Phase 2 must not design contracts for them.

## Recommendation

Ready for independent architecture and acceptance review.

Phase 1 is not declared accepted here. Acceptance requires explicit user acceptance after review.
Once accepted, the recommended next step is Phase 2 — Internal API Contracts, which must also carry
`D-012` (structured error envelope and correlation logging), whose trigger is the first API route.

`D-013` no longer carries forward: it was resolved in this phase by enabling type-aware linting.
