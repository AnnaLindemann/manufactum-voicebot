import { z } from "zod";

/**
 * Raw upstream schema for the observed `GET /search` response.
 *
 * It mirrors the observed JSON exactly: snake_case, and no field that was not observed. These types
 * never leave the integration layer.
 *
 * Strict about what is consumed, tolerant about what is not. Every field that is mapped into the
 * public internal contract must be present and carry its observed type, or the whole response is
 * rejected as `UPSTREAM_INVALID_RESPONSE`. Unknown additional upstream fields are stripped, so
 * upstream may add fields without breaking us.
 *
 * `manufacturer` and `status_text` are modelled but optional. They are deliberately not part of the
 * public contract (see `D-015`), so their absence must not fail a response that can still answer the
 * caller's question correctly. Modelling them keeps a *type* change visible — a `manufacturer` that
 * turns into a number is still rejected — without making a field nobody consumes load-bearing.
 */

const upstreamAvailabilitySchema = z.object({
  warehouse_id: z.string(),
  warehouse: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  opening_hours: z.record(z.string(), z.string()),
  // Left as an open string: an unrecognized value maps to the internal `unknown` status rather than
  // failing the response. This is the single deliberate exception to strict rejection.
  status: z.string(),
  // Not a public-contract field: optional, but still type-checked when present.
  status_text: z.string().optional(),
  stock: z.number().nullable(),
});

const upstreamProductSchema = z.object({
  name: z.string(),
  sku: z.string(),
  // Not a public-contract field: optional, but still type-checked when present.
  manufacturer: z.string().optional(),
  price: z.string().nullable(),
  product_url: z.string().nullable(),
  description: z.string().nullable(),
  highlights: z.array(z.string()),
  warehouse_availability: z.array(upstreamAvailabilitySchema),
});

export const upstreamSearchResponseSchema = z.object({
  query: z.string(),
  result_count: z.number(),
  products: z.array(upstreamProductSchema),
});

export type UpstreamSearchResponse = z.infer<typeof upstreamSearchResponseSchema>;
