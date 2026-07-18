# Test Strategy

## API discovery

Verify raw external behavior.

## Unit tests

- phone normalization;
- postal-code validation;
- product normalization;
- availability mapping;
- request validation;
- error mapping;
- document hashing;
- chunk-key generation.

Price is **not** parsed into a number in the MVP, so there is no price-parsing test. The test is that
`priceText` is carried through verbatim and unmodified. See `D-015`.

## Integration tests

Mock the external API and test internal endpoints.

## Contract tests

Store representative redacted responses and verify parsers still accept them.

## Product-search tests (Phase 3)

The MVP contract in `api-contracts.md` is testable as follows. These tests are written in Phase 3,
alongside the route.

Mapping:

- the stored redacted sample maps to the expected internal model;
- `AVAILABLE` maps to `in_stock`; `OUT_OF_STOCK` maps to `out_of_stock`;
- an unrecognized upstream status maps to `unknown`, is logged with its raw value, and is never
  emitted as `in_stock` or `out_of_stock`;
- `priceText` is byte-identical to the upstream `price` string;
- `manufacturer` and `status_text` are parsed from upstream and absent from the mapped output;
- an upstream response missing a mapped field, or carrying a wrong type, is rejected as
  `UPSTREAM_INVALID_RESPONSE` rather than partially mapped.

Request validation:

- empty, whitespace-only, and over-length `q` produce `INVALID_REQUEST`;
- `limit` values of `abc`, `1.5`, `0`, `-1`, `6`, and `100` produce `INVALID_REQUEST`;
- `limit` of 1 and 5 are accepted; an omitted `limit` sends 5 explicitly upstream;
- invalid input never results in an upstream call.

Responses and errors:

- a no-match query returns `200` with `resultCount: 0`, not an error;
- an empty availability list is returned as `[]` with no reason code and no stock claim;
- every error code in `api-contracts.md` produces its documented status and retryable flag;
- no upstream body text and no upstream status code appears in any internal response;
- no log line or response body contains the API key or a raw upstream body;
- an unknown route returns the `404` envelope with a correlation ID.

## RAG tests

- exact question;
- paraphrased question;
- irrelevant question;
- inactive version excluded;
- source returned;
- low-confidence fallback;
- changed page creates new version;
- unchanged page creates no version.

## Voice tests

- German product names;
- numbers;
- article numbers;
- postal codes;
- interruptions;
- silence;
- noise;
- long names;
- corrections.

## Reservation safety

- double submit;
- duplicate confirmation;
- invalid reference;
- already cancelled;
- timeout after submit;
- unknown final state.

## Acceptance criteria

- no hallucinated price or stock;
- no reservation without confirmation;
- no inactive RAG chunk used;
- safe fallback on upstream failure;
- traceable answer source.
