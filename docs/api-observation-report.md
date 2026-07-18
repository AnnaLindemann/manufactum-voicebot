# API Observation Report

## Status

In progress.

This report contains only observed results from Phase 1 API discovery.

## Evidence rules

- Record only observed API behavior.
- Do not infer undocumented fields or capabilities.
- Redact API keys, authorization headers, personal data, and sensitive identifiers.
- Store only redacted sample responses.

## Tested endpoints

### GET /search

Observed base URL:

```text
https://warehouse-api.manufactum-dev.beyondtouch.io
```

Observed authentication:

```text
x-api-key: [REDACTED]
```

## Observed request behavior

- `q` is required. An empty value returns HTTP `400`.
- A keyword query works: `q=senf`.
- An exact article-number query works: `q=209567`.
- `warehouse` is optional.
- The observed Berlin warehouse is accepted in both formats:
  - `493024033844`
  - `+493024033844`
- Omitting `warehouse` returns availability for multiple stores.
- An unknown `warehouse` still returns the matching product but with an empty `warehouse_availability` array.
- `limit=1` returns one result for `q=senf`.
- `limit=2` returns two results for `q=senf`.
- In the observed `q=senf` test, `limit=0` and `limit=-1` each returned one result.
- An exact product-name query can return related variants.
- One observed typo query also returned related products, but with a different result order.
- An umlaut query was accepted, but the observed result set contained related products rather than the previously observed exact product.
- Omitting `limit` returned five results for the observed `q=senf` query.
- A non-integer `limit` returned HTTP `400` with an explicit validation error.
- `limit=100` returned eleven results for the observed `q=senf` query; the upstream maximum remains unknown.
- One query containing spaces and `&` was accepted and returned matching products.

## Observed response behavior

A successful response has this top-level shape:

```json
{
  "query": "string",
  "result_count": 0,
  "products": []
}
```

Observed product fields:

```text
name
sku
manufacturer
price
product_url
description
highlights
warehouse_availability
```

Observed availability fields:

```text
warehouse_id
warehouse
address
phone
opening_hours
status
status_text
stock
```

Observed field representations:

| Field                    | Observed representation                                      |
| ------------------------ | ------------------------------------------------------------ |
| `query`                  | string                                                       |
| `result_count`           | number                                                       |
| `products`               | array                                                        |
| `sku`                    | string, including numeric article numbers such as `"209567"` |
| `price`                  | localized string, for example `"11,90 €"`                    |
| `highlights`             | array of strings                                             |
| `warehouse_availability` | array; may be empty                                          |
| `opening_hours`          | object with German weekday keys and string values            |
| `status`                 | string; observed values: `AVAILABLE`, `OUT_OF_STOCK`         |
| `stock`                  | number; observed values include positive integers and `0`    |

Observed `opening_hours` is an object keyed by German weekday names.

- Observed availability status values include `AVAILABLE` and `OUT_OF_STOCK`. In the observed `OUT_OF_STOCK` response, `stock` was `0`.

## Errors and edge cases

| Test                | Observed result                                                         |
| ------------------- | ----------------------------------------------------------------------- |
| No authentication   | HTTP `403`, body: `{"message":"Forbidden"}`                             |
| Empty `q`           | HTTP `400`, body: `{"error":"Query parameter 'q' is required"}`         |
| No matching product | HTTP `200`, `result_count: 0`, `products: []`                           |
| Unknown warehouse   | HTTP `200`; matching product returned with `warehouse_availability: []` |

## Confirmed capabilities

- Product search by keyword.
- Product search by exact article number.
- Warehouse-filtered availability.
- Availability across multiple stores when `warehouse` is omitted.
- Product price, URL, description, highlights, store details, availability status, and stock quantity are present in observed responses.

## Unsupported or unknown capabilities

- Exact product-name matching behavior.
- Partial-word, typo, umlaut, long-text, and special-character search behavior.
- Maximum supported `limit`.
- Non-numeric `limit` behavior.
- Pagination and rate limits.
- Online availability.
- Alternatives, variants, categories, and reservation endpoints.
- Whether all product and availability fields are stable across responses.

## Contract changes based on evidence

None.

Internal API contracts, Domain Model, and voice scenarios remain unchanged during discovery.

## Open questions

- Is the observed product-response structure stable?
- Does `warehouse` accept only phone numbers or other identifiers?
- How should the backend distinguish an unknown warehouse from a real warehouse with no stock?
- What is the documented limit normalization rule?
- Which reservation and store-resolution endpoints exist?
