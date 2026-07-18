# API Discovery Log

## Recording rules

- Record observed behavior only.
- Do not include API-key values or authorization-header values.
- Keep full responses only as redacted samples.
- Update `api-observation-report.md` after a meaningful group of tests.

## 2026-07-18 — Postman discovery

| ID      | Request variant                                                       | Observed result                                                                                                                                                     |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXP-001 | No authentication; `q=senf`, Berlin warehouse, `limit=2`              | HTTP `403`; body `{"message":"Forbidden"}`.                                                                                                                         |
| EXP-002 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=2`              | Successful response; `result_count: 2`; product and filtered warehouse availability returned.                                                                       |
| EXP-003 | Valid `x-api-key`; `q=209567`, Berlin warehouse; no `limit`           | HTTP `200`; `result_count: 1`; returned product `sku: "209567"`.                                                                                                    |
| EXP-004 | Valid `x-api-key`; `q=209567`; omitted `warehouse`                    | HTTP `200`; product returned with availability for 17 stores.                                                                                                       |
| EXP-005 | Valid `x-api-key`; `q=209567`; `warehouse=+493024033844`              | HTTP `200`; one matching Berlin Berlin warehouse availability returned.                                                                                             |
| EXP-006 | Valid `x-api-key`; `q=209567`; `warehouse=not-a-real-warehouse`       | HTTP `200`; product returned with `warehouse_availability: []`.                                                                                                     |
| EXP-007 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=1`              | One result returned.                                                                                                                                                |
| EXP-008 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=0`              | HTTP `200`; one result returned.                                                                                                                                    |
| EXP-009 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=-1`             | One result returned.                                                                                                                                                |
| EXP-010 | Valid `x-api-key`; no-match query, Berlin warehouse, `limit=2`        | HTTP `200`; `result_count: 0`; `products: []`.                                                                                                                      |
| EXP-011 | Valid `x-api-key`; empty `q`, Berlin warehouse, `limit=2`             | HTTP `400`; body `{"error":"Query parameter 'q' is required"}`.                                                                                                     |
| EXP-012 | Node.js / TypeScript script; `q=senf`, Berlin warehouse, `limit=2`    | HTTP `200`; response matched the observed Postman result; redacted sample saved to `docs/api-samples/search-response.redacted.json`.                                |
| EXP-013 | Valid `x-api-key`; `q=Moutarde de Dijon`, Berlin warehouse, `limit=2` | Two related products returned: `218467` and `218468`; exact-name query is not unique.                                                                               |
| EXP-014 | Valid `x-api-key`; `q=Moutarde de Djon`, Berlin warehouse, `limit=2`  | Two related products returned despite one typo; order was `218468`, then `218467`.                                                                                  |
| EXP-015 | Valid `x-api-key`; `q=Bewässerungstopf`, Berlin warehouse, `limit=2`  | Two related products returned: `221009` and `221010`; neither was the previously observed exact product `209567`. Both had `status: "OUT_OF_STOCK"` and `stock: 0`. |
| EXP-016 | Valid `x-api-key`; `q=Bewaesserungstopf`, Berlin warehouse, `limit=2` | Same two results as `q=Bewässerungstopf`: `221009` and `221010`, both out of stock.                                                                                 |

## Follow-up

| EXP-017 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=abc` | HTTP `400`; body `{"error":"Query parameter 'limit' must be an integer"}`. |
| EXP-018 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=10` | Ten results returned. |
| EXP-019 | Valid `x-api-key`; `q=senf`, Berlin warehouse, `limit=100` | Eleven results returned; no maximum limit was established because only eleven matching products were observed. |
| EXP-020 | Valid `x-api-key`; `q=senf`, Berlin warehouse; omitted `limit` | Five results returned. |
| EXP-021 | Valid `x-api-key`; `q=Moutard`, Berlin warehouse, `limit=2` | Partial-word query returned `218467` and `218468`. |
| EXP-022 | Valid `x-api-key`; `q=senf & honig`, Berlin warehouse, `limit=2` | Query with spaces and `&` returned `27814` and `217118`. |

- Create a redacted sample with the local TypeScript discovery script.
- Test remaining planned search variants and unknown API capabilities.
