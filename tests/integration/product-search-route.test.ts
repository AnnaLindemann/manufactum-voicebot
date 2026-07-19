import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createRateLimiter, RATE_LIMIT_MAX_REQUESTS } from "../../src/http/rate-limit.js";
import { createProductSearchClient } from "../../src/integrations/manufactum/product-search-client.js";
import { createProductSearchService } from "../../src/services/product-search-service.js";
import type { ProductSearchResponse } from "../../src/domain/product-search.js";
import type { ErrorEnvelope } from "../../src/errors/app-error.js";
import {
  createFetchStub,
  createRecordingLogger,
  jsonResponse,
  TEST_CONFIG,
} from "../helpers/test-doubles.js";

/**
 * Integration tests drive the real route, validation, service, client, schema, mapper, and
 * middleware. Only `fetch` is mocked, so no real upstream call is made.
 */
function createTestApp(
  upstream: Response | (() => Promise<Response>),
  { rateLimiter }: { rateLimiter?: RequestHandler } = {},
) {
  const logger = createRecordingLogger();
  const { fetchImplementation, calls } = createFetchStub(upstream);

  const app = createApp({
    logger,
    productSearchService: createProductSearchService(
      createProductSearchClient({ loadConfig: () => TEST_CONFIG, fetchImplementation, logger }),
    ),
    ...(rateLimiter === undefined ? {} : { rateLimiter }),
  });

  return { app, calls, logger };
}

/**
 * Supertest types `response.body` as `any`. Asserting it to the contracted shape keeps the tests
 * type-checked against the same models the route returns.
 */
function successBody(response: { body: unknown }): ProductSearchResponse {
  return response.body as ProductSearchResponse;
}

function errorBody(response: { body: unknown }): ErrorEnvelope {
  return response.body as ErrorEnvelope;
}

const UPSTREAM_BODY = {
  query: "senf",
  result_count: 1,
  products: [
    {
      name: "Moutarde de Dijon",
      sku: "218467",
      manufacturer: "Edmond Fallot Moutardier",
      price: "11,90 €",
      product_url: "https://www.manufactum.de/moutarde-de-dijon-a218467/",
      description: "250-g-Fässchen",
      highlights: ["Zwischen Granitmühlsteinen kalt vermahlen"],
      warehouse_availability: [
        {
          warehouse_id: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
          warehouse: "Manufactum Berlin",
          address: "Hardenbergstraße 4-5, 10623 Berlin",
          phone: "+49 30 24033844",
          opening_hours: { Montag: "10:00 - 20:00 Uhr" },
          status: "AVAILABLE",
          status_text: "Verfügbar",
          stock: 7,
        },
      ],
    },
  ],
};

const BERLIN_HARDENBERG_UPSTREAM = UPSTREAM_BODY.products[0]?.warehouse_availability[0];

const BERLIN_KGA_UPSTREAM = {
  warehouse_id: "MANUFACTUM_BERLIN_KGA",
  warehouse: "Manufactum Berlin KaDeWe",
  address: "Tauentzienstraße 21-24, 10789 Berlin",
  phone: "+49 30 21010000",
  opening_hours: { Montag: "10:00 - 20:00 Uhr" },
  status: "OUT_OF_STOCK",
  status_text: "Nicht verfügbar",
  stock: 0,
};

const MUNICH_UPSTREAM = {
  warehouse_id: "MANUFACTUM_MUENCHEN",
  warehouse: "Manufactum München",
  address: "Dienerstraße 12, 80331 München",
  phone: "+49 89 23545900",
  opening_hours: { Montag: "10:00 - 19:00 Uhr" },
  status: "AVAILABLE",
  status_text: "Verfügbar",
  stock: 3,
};

/** One product carried by two Berlin branches and one Munich branch. */
const MULTI_STORE_BODY = {
  ...UPSTREAM_BODY,
  products: [
    {
      ...UPSTREAM_BODY.products[0],
      warehouse_availability: [BERLIN_HARDENBERG_UPSTREAM, BERLIN_KGA_UPSTREAM, MUNICH_UPSTREAM],
    },
  ],
};

function storeIds(response: { body: unknown }): (string | undefined)[] {
  return (successBody(response).products[0]?.availability ?? []).map((entry) => entry.warehouseId);
}

describe("GET /api/products/search", () => {
  it("returns 200 with the mapped internal model", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      query: "senf",
      resultCount: 1,
      storeResolution: { status: "not_requested" },
      products: [
        {
          sku: "218467",
          name: "Moutarde de Dijon",
          priceText: "11,90 €",
          description: "250-g-Fässchen",
          highlights: ["Zwischen Granitmühlsteinen kalt vermahlen"],
          productUrl: "https://www.manufactum.de/moutarde-de-dijon-a218467/",
          availability: [
            {
              warehouseId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
              warehouseName: "Manufactum Berlin",
              address: "Hardenbergstraße 4-5, 10623 Berlin",
              phone: "+49 30 24033844",
              openingHours: { Montag: "10:00 - 20:00 Uhr" },
              status: "in_stock",
              stock: 7,
            },
          ],
        },
      ],
    });
  });

  it("keeps every store's availability when no store was requested", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(200);
    expect(successBody(response).storeResolution).toEqual({ status: "not_requested" });
    expect(storeIds(response)).toEqual([
      "MANUFACTUM_BERLIN_HAUS_HADENBERG",
      "MANUFACTUM_BERLIN_KGA",
      "MANUFACTUM_MUENCHEN",
    ]);
  });

  it("returns 200 with resultCount 0 for a no-match query, not an error", async () => {
    const { app } = createTestApp(jsonResponse({ query: "xyzzy", result_count: 0, products: [] }));

    const response = await request(app).get("/api/products/search").query({ q: "xyzzy" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      query: "xyzzy",
      resultCount: 0,
      storeResolution: { status: "not_requested" },
      products: [],
    });
    expect(response.body).not.toHaveProperty("code");
  });

  it("returns an empty availability list with no reason code and no stock claim", async () => {
    const { app } = createTestApp(
      jsonResponse({
        ...UPSTREAM_BODY,
        products: [{ ...UPSTREAM_BODY.products[0], warehouse_availability: [] }],
      }),
    );

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(200);
    expect(successBody(response).products[0]?.availability).toEqual([]);
    // The empty array is the only signal. Nothing explains why.
    expect(Object.keys(successBody(response).products[0] ?? {})).not.toContain(
      "availabilityReason",
    );
    expect(JSON.stringify(response.body)).not.toContain("out_of_stock");
  });

  it.each([
    ["missing q", {}],
    ["whitespace-only q", { q: "   " }],
    ["over-length q", { q: "a".repeat(201) }],
    ["limit abc", { q: "senf", limit: "abc" }],
    ["limit 1.5", { q: "senf", limit: "1.5" }],
    ["limit 0", { q: "senf", limit: "0" }],
    ["limit -1", { q: "senf", limit: "-1" }],
    ["limit 6", { q: "senf", limit: "6" }],
    ["limit 100", { q: "senf", limit: "100" }],
    [
      "store and storeId together",
      { q: "senf", store: "Berlin", storeId: "MANUFACTUM_BERLIN_KGA" },
    ],
    [
      "store and the deprecated warehouseId together",
      { q: "senf", store: "Berlin", warehouseId: "MANUFACTUM_BERLIN_KGA" },
    ],
    [
      "storeId and the deprecated warehouseId together",
      { q: "senf", storeId: "MANUFACTUM_BERLIN_KGA", warehouseId: "MANUFACTUM_MUENCHEN" },
    ],
    ["empty store", { q: "senf", store: "   " }],
    ["empty storeId", { q: "senf", storeId: "   " }],
    ["empty warehouseId", { q: "senf", warehouseId: "   " }],
    ["over-length warehouseId", { q: "senf", warehouseId: "a".repeat(65) }],
    ["over-length store", { q: "senf", store: "a".repeat(121) }],
    ["over-length storeId", { q: "senf", storeId: "a".repeat(65) }],
  ])("rejects %s with INVALID_REQUEST and makes no upstream call", async (_label, query) => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query(query);

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("INVALID_REQUEST");
    expect(errorBody(response).retryable).toBe(false);
    expect(errorBody(response).correlationId).toEqual(expect.any(String));
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["1", 1],
    ["5", 5],
  ])("accepts limit %s and forwards it upstream", async (limit, expected) => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf", limit });

    expect(response.status).toBe(200);
    expect(calls[0]?.url.searchParams.get("limit")).toBe(String(expected));
  });

  it("sends limit=5 explicitly when it is omitted", async () => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    await request(app).get("/api/products/search").query({ q: "senf" });

    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
  });

  it.each([
    [403, "UPSTREAM_AUTH_FAILED", 502, false],
    [400, "UPSTREAM_REJECTED_REQUEST", 502, false],
    [500, "UPSTREAM_UNAVAILABLE", 502, true],
  ])("maps upstream %i to %s with status %i", async (upstreamStatus, code, status, retryable) => {
    const { app } = createTestApp(
      jsonResponse({ message: "Forbidden", error: "internal upstream detail" }, upstreamStatus),
    );

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(status);
    expect(errorBody(response).code).toBe(code);
    expect(errorBody(response).retryable).toBe(retryable);
    // Neither the upstream status code nor its body text appears in the internal response.
    // correlationId is excluded from the substring check on purpose: it is a random UUID whose hex
    // digits can contain "400" or "500" by chance, which made this assertion flaky roughly one run
    // in twelve. The leak this guards against would appear in the other three fields.
    const { correlationId, ...withoutCorrelationId } = errorBody(response);
    const serialized = JSON.stringify(withoutCorrelationId);

    expect(correlationId).toEqual(expect.any(String));
    expect(serialized).not.toContain(String(upstreamStatus));
    expect(serialized).not.toContain("Forbidden");
    expect(serialized).not.toContain("internal upstream detail");
  });

  it("maps an upstream connection failure to a retryable 504", async () => {
    const { app } = createTestApp(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(504);
    expect(errorBody(response).code).toBe("UPSTREAM_TIMEOUT");
    expect(errorBody(response).retryable).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
  });

  it("rejects a schema-violating upstream response with 502 and no partial product", async () => {
    const { app } = createTestApp(
      jsonResponse({
        ...UPSTREAM_BODY,
        products: [{ ...UPSTREAM_BODY.products[0], price: 1190 }],
      }),
    );

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(502);
    expect(errorBody(response).code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(response.body).not.toHaveProperty("products");
  });

  it("never leaks the API key in a response body or header", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(JSON.stringify(response.body)).not.toContain(TEST_CONFIG.apiKey);
    expect(JSON.stringify(response.headers)).not.toContain(TEST_CONFIG.apiKey);
  });
});

describe("store selection", () => {
  it("filters availability to the one store named by an exact storeId", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", storeId: "MANUFACTUM_BERLIN_KGA" });

    expect(response.status).toBe(200);
    expect(successBody(response).storeResolution).toEqual({
      status: "matched",
      selectedStore: {
        storeId: "MANUFACTUM_BERLIN_KGA",
        warehouseName: "Manufactum Berlin KaDeWe",
        address: "Tauentzienstraße 21-24, 10789 Berlin",
      },
    });
    expect(storeIds(response)).toEqual(["MANUFACTUM_BERLIN_KGA"]);
  });

  it("returns an empty availability list for a product the selected store does not carry", async () => {
    const { app } = createTestApp(
      jsonResponse({
        ...MULTI_STORE_BODY,
        products: [
          {
            ...MULTI_STORE_BODY.products[0],
            warehouse_availability: [MUNICH_UPSTREAM],
          },
        ],
      }),
    );

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", storeId: "MANUFACTUM_MUENCHEN" });

    // The store resolved, so filtering is legitimate; the product simply is not in Berlin's list.
    expect(successBody(response).storeResolution.status).toBe("matched");
    expect(storeIds(response)).toEqual(["MANUFACTUM_MUENCHEN"]);
  });

  it("reports not_found for an unknown storeId without claiming the product is absent", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", storeId: "MANUFACTUM_NOWHERE" });

    expect(response.status).toBe(200);
    expect(successBody(response).storeResolution).toEqual({ status: "not_found" });
    // Nothing was selected, so nothing is filtered. An emptied list would read as "not stocked
    // here", which is a stock claim about a store that was never identified.
    expect(storeIds(response)).toHaveLength(3);
    expect(successBody(response).storeResolution).not.toHaveProperty("selectedStore");
  });

  it("reports ambiguous with both Berlin branches as candidates", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", store: "Berlin" });

    expect(response.status).toBe(200);
    expect(successBody(response).storeResolution).toEqual({
      status: "ambiguous",
      query: "Berlin",
      candidates: [
        {
          storeId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
          warehouseName: "Manufactum Berlin",
          address: "Hardenbergstraße 4-5, 10623 Berlin",
        },
        {
          storeId: "MANUFACTUM_BERLIN_KGA",
          warehouseName: "Manufactum Berlin KaDeWe",
          address: "Tauentzienstraße 21-24, 10789 Berlin",
        },
      ],
    });
    // No branch was chosen, so no `selectedStore` is offered for one to be read from.
    expect(successBody(response).storeResolution).not.toHaveProperty("selectedStore");
  });

  it("matches and filters when a store query resolves to exactly one branch", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", store: "München" });

    expect(successBody(response).storeResolution).toEqual({
      status: "matched",
      query: "München",
      selectedStore: {
        storeId: "MANUFACTUM_MUENCHEN",
        warehouseName: "Manufactum München",
        address: "Dienerstraße 12, 80331 München",
      },
    });
    expect(storeIds(response)).toEqual(["MANUFACTUM_MUENCHEN"]);
  });

  it("matches the transliterated spelling of an umlaut city", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", store: "muenchen" });

    expect(successBody(response).storeResolution).toMatchObject({
      status: "matched",
      selectedStore: { storeId: "MANUFACTUM_MUENCHEN" },
    });
  });

  it("reports not_found with the echoed query for an unknown store", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", store: "Hamburg" });

    expect(response.status).toBe(200);
    expect(successBody(response).storeResolution).toEqual({
      status: "not_found",
      query: "Hamburg",
    });
    expect(storeIds(response)).toHaveLength(3);
  });

  it("treats the deprecated warehouseId exactly like storeId", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const viaAlias = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "MANUFACTUM_BERLIN_KGA" });
    const viaStoreId = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", storeId: "MANUFACTUM_BERLIN_KGA" });

    expect(viaAlias.status).toBe(200);
    // Byte-for-byte identical: the alias is a spelling, not a second behavior.
    expect(viaAlias.body).toEqual(viaStoreId.body);
    expect(successBody(viaAlias).storeResolution).toMatchObject({
      status: "matched",
      selectedStore: { storeId: "MANUFACTUM_BERLIN_KGA" },
    });
    expect(storeIds(viaAlias)).toEqual(["MANUFACTUM_BERLIN_KGA"]);
  });

  it("reports not_found for an unknown warehouseId, as it does for an unknown storeId", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "MANUFACTUM_NOWHERE" });

    expect(successBody(response).storeResolution).toEqual({ status: "not_found" });
    expect(storeIds(response)).toHaveLength(3);
  });

  it("never echoes the deprecated parameter name back in the response", async () => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "MANUFACTUM_BERLIN_KGA" });

    // The alias collapses at the validation boundary. A response that named it would keep the
    // deprecated spelling alive in a second place.
    expect(JSON.stringify(response.body)).not.toContain("warehouseFilterApplied");
    expect(successBody(response).storeResolution).not.toHaveProperty("warehouseId");
  });

  it.each([
    ["ambiguous", { q: "senf", store: "Berlin" }],
    ["not_found via store", { q: "senf", store: "Hamburg" }],
    ["not_found via storeId", { q: "senf", storeId: "MANUFACTUM_NOWHERE" }],
    ["not_found via the deprecated warehouseId", { q: "senf", warehouseId: "MANUFACTUM_NOWHERE" }],
  ])("leaves availability complete and unfiltered when resolution is %s", async (_label, query) => {
    const { app } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    const response = await request(app).get("/api/products/search").query(query);
    const unselected = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(200);
    expect(["ambiguous", "not_found"]).toContain(successBody(response).storeResolution.status);

    // No store was unambiguously selected, so this list is NOT availability at a chosen store — it
    // is every store's availability, exactly as an unselected request returns it. Filtering it
    // would attribute one branch's stock to a branch that was never identified; emptying it would
    // manufacture the `availability: []` shape a consumer reads as "not stocked at your store".
    expect(successBody(response).products[0]?.availability).toEqual(
      successBody(unselected).products[0]?.availability,
    );
    expect(storeIds(response)).toEqual([
      "MANUFACTUM_BERLIN_HAUS_HADENBERG",
      "MANUFACTUM_BERLIN_KGA",
      "MANUFACTUM_MUENCHEN",
    ]);
    // And no store is offered as the selected one for a consumer to read stock against.
    expect(successBody(response).storeResolution).not.toHaveProperty("selectedStore");
  });

  it("never sends a store parameter upstream", async () => {
    const { app, calls } = createTestApp(jsonResponse(MULTI_STORE_BODY));

    await request(app).get("/api/products/search").query({ q: "senf", store: "Berlin" });
    await request(app)
      .get("/api/products/search")
      .query({ q: "senf", storeId: "MANUFACTUM_BERLIN_KGA" });

    await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "MANUFACTUM_BERLIN_KGA" });

    for (const call of calls) {
      expect(call.url.searchParams.has("warehouse")).toBe(false);
      expect(call.url.searchParams.has("store")).toBe(false);
      expect(call.url.searchParams.has("storeId")).toBe(false);
      expect(call.url.searchParams.has("warehouseId")).toBe(false);
    }
  });

  it.each([
    ["no store selection", { q: "senf", limit: "2" }],
    ["a matched store", { q: "senf", limit: "2", storeId: "MANUFACTUM_BERLIN_KGA" }],
    ["an ambiguous store", { q: "senf", limit: "2", store: "Berlin" }],
    ["an unknown store", { q: "senf", limit: "2", store: "Hamburg" }],
  ])("limits the number of products, not availability entries, with %s", async (_label, query) => {
    const twoProducts = {
      ...MULTI_STORE_BODY,
      result_count: 2,
      products: [
        MULTI_STORE_BODY.products[0],
        { ...MULTI_STORE_BODY.products[0], sku: "218468", name: "Moutarde à l'ancienne" },
      ],
    };
    const { app, calls } = createTestApp(jsonResponse(twoProducts));

    const response = await request(app).get("/api/products/search").query(query);

    expect(response.status).toBe(200);
    // limit still governs products alone, and is still what gets forwarded upstream.
    expect(calls[0]?.url.searchParams.get("limit")).toBe("2");
    expect(successBody(response).products).toHaveLength(2);
    expect(successBody(response).resultCount).toBe(2);
  });
});

describe("correlation ID", () => {
  it("echoes an inbound correlation ID in the header and the error envelope", async () => {
    const { app } = createTestApp(jsonResponse({ message: "Forbidden" }, 403));

    const response = await request(app)
      .get("/api/products/search")
      .set("x-correlation-id", "caller-supplied-42")
      .query({ q: "senf" });

    expect(response.headers["x-correlation-id"]).toBe("caller-supplied-42");
    expect(errorBody(response).correlationId).toBe("caller-supplied-42");
  });

  it("generates one when no inbound header is present", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ignores x-request-id and generates its own ID instead", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .set("x-request-id", "not-honoured")
      .query({ q: "senf" });

    // x-correlation-id is the only accepted inbound spelling.
    expect(response.headers["x-correlation-id"]).not.toBe("not-honoured");
    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates its own ID when x-correlation-id is present but empty", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app)
      .get("/api/products/search")
      .set("x-correlation-id", "   ")
      .query({ q: "senf" });

    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs the request with its correlation ID, endpoint, and latency", async () => {
    const { app, logger } = createTestApp(jsonResponse(UPSTREAM_BODY));

    await request(app)
      .get("/api/products/search")
      .set("x-correlation-id", "cid-logged")
      .query({ q: "senf" });

    const entry = logger.entries.find((line) => line.event === "request_completed");

    expect(entry?.fields.correlationId).toBe("cid-logged");
    expect(entry?.fields.endpoint).toBe("GET /api/products/search");
    expect(typeof entry?.fields.requestLatencyMs).toBe("number");
    // The caller's spoken search term is deliberately not logged.
    expect(JSON.stringify(logger.entries)).not.toContain("senf");
  });
});

describe("latency metrics", () => {
  it("reports both metrics on the completion line when an upstream call was made", async () => {
    const { app, logger } = createTestApp(jsonResponse(UPSTREAM_BODY));

    await request(app).get("/api/products/search").query({ q: "senf" });

    const completion = logger.entries.find((line) => line.event === "request_completed");

    expect(typeof completion?.fields.requestLatencyMs).toBe("number");
    expect(typeof completion?.fields.upstreamLatencyMs).toBe("number");
    // Total handling time can never be shorter than the upstream portion it contains.
    expect(completion?.fields.requestLatencyMs).toBeGreaterThanOrEqual(
      completion?.fields.upstreamLatencyMs ?? 0,
    );
  });

  it("agrees with the upstream log line about the upstream portion", async () => {
    const { app, logger } = createTestApp(jsonResponse(UPSTREAM_BODY));

    await request(app).get("/api/products/search").query({ q: "senf" });

    const upstream = logger.entries.find((line) => line.event === "upstream_request_completed");
    const completion = logger.entries.find((line) => line.event === "request_completed");

    expect(upstream?.fields.upstreamLatencyMs).toBe(completion?.fields.upstreamLatencyMs);
    expect(upstream?.fields).not.toHaveProperty("latencyMs");
    expect(upstream?.fields).not.toHaveProperty("requestLatencyMs");
  });

  it.each([
    ["a rejected request that never reaches upstream", { q: "" }],
    ["an unknown route", undefined],
  ])("omits upstreamLatencyMs for %s", async (_label, query) => {
    const { app, logger } = createTestApp(jsonResponse(UPSTREAM_BODY));

    await (query === undefined
      ? request(app).get("/api/nope")
      : request(app).get("/api/products/search").query(query));

    const completion = logger.entries.find((line) => line.event === "request_completed");

    expect(typeof completion?.fields.requestLatencyMs).toBe("number");
    // No upstream call happened, so claiming an upstream time would be a fabricated measurement.
    expect(completion?.fields).not.toHaveProperty("upstreamLatencyMs");
  });

  it("still reports the upstream portion when the upstream call fails", async () => {
    const { app, logger } = createTestApp(() => Promise.reject(new Error("connect ECONNREFUSED")));

    await request(app).get("/api/products/search").query({ q: "senf" });

    const completion = logger.entries.find((line) => line.event === "request_completed");
    const failure = logger.entries.find((line) => line.event === "upstream_request_failed");

    expect(typeof failure?.fields.upstreamLatencyMs).toBe("number");
    expect(typeof completion?.fields.upstreamLatencyMs).toBe("number");
    expect(completion?.fields.errorCode).toBe("UPSTREAM_TIMEOUT");
  });

  it("reports the upstream portion even when the upstream response fails validation", async () => {
    const { app, logger } = createTestApp(
      jsonResponse({ ...UPSTREAM_BODY, products: [{ ...UPSTREAM_BODY.products[0], price: 1190 }] }),
    );

    await request(app).get("/api/products/search").query({ q: "senf" });

    const completion = logger.entries.find((line) => line.event === "request_completed");

    // The body read, validation, and mapping happen after the upstream measurement stops, so the
    // two figures must both be present and the total must still be the larger.
    expect(typeof completion?.fields.upstreamLatencyMs).toBe("number");
    expect(completion?.fields.requestLatencyMs).toBeGreaterThanOrEqual(
      completion?.fields.upstreamLatencyMs ?? 0,
    );
    expect(completion?.fields.errorCode).toBe("UPSTREAM_INVALID_RESPONSE");
  });
});

describe("404 handler", () => {
  it.each(["/api/unknown", "/api/products/218467", "/api/reservations"])(
    "returns the NOT_FOUND envelope with a correlation ID for %s",
    async (path) => {
      const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
      expect(errorBody(response).code).toBe("NOT_FOUND");
      expect(errorBody(response).retryable).toBe(false);
      expect(errorBody(response).correlationId).toEqual(expect.any(String));
      expect(errorBody(response).safeCustomerMessage).toEqual(expect.any(String));
    },
  );
});

describe("rate limiting", () => {
  /** A frozen clock keeps every request of a test inside one window. */
  function createLimitedApp() {
    return createTestApp(jsonResponse(UPSTREAM_BODY), {
      rateLimiter: createRateLimiter({ now: () => 1_000 }),
    });
  }

  async function exhaustBudget(app: Parameters<typeof request>[0]) {
    for (let sent = 1; sent <= RATE_LIMIT_MAX_REQUESTS; sent += 1) {
      await request(app).get("/api/products/search?q=senf");
    }
  }

  it("serves the agreed 20 requests per minute before rejecting", async () => {
    const { app } = createLimitedApp();

    for (let sent = 1; sent <= RATE_LIMIT_MAX_REQUESTS; sent += 1) {
      const response = await request(app).get("/api/products/search?q=senf");

      expect(response.status, `request ${sent} should be served`).toBe(200);
    }

    expect((await request(app).get("/api/products/search?q=senf")).status).toBe(429);
  });

  it("returns the structured envelope, not a bare status, when the budget is spent", async () => {
    const { app } = createLimitedApp();
    await exhaustBudget(app);

    const response = await request(app).get("/api/products/search?q=senf");

    expect(response.status).toBe(429);
    expect(errorBody(response).code).toBe("RATE_LIMITED");
    expect(errorBody(response).retryable).toBe(true);
    expect(errorBody(response).correlationId).toEqual(expect.any(String));
    expect(errorBody(response).safeCustomerMessage).toEqual(expect.any(String));
    // The safe message stays free of technical detail: no limit, no window, no parameter name.
    expect(errorBody(response).safeCustomerMessage).not.toMatch(/\d/);
  });

  it("tells the caller how long to wait", async () => {
    const { app } = createLimitedApp();
    await exhaustBudget(app);

    const response = await request(app).get("/api/products/search?q=senf");

    expect(response.headers["retry-after"]).toBe("60");
  });

  it("makes no upstream call for a rejected request", async () => {
    const { app, calls } = createLimitedApp();
    await exhaustBudget(app);

    await request(app).get("/api/products/search?q=senf");

    // The whole point of the limit: a rejected request must not spend our upstream credential.
    expect(calls).toHaveLength(RATE_LIMIT_MAX_REQUESTS);
  });

  it("logs the rejection with its error code and without the query text", async () => {
    const { app, logger } = createLimitedApp();
    await exhaustBudget(app);

    await request(app).get("/api/products/search?q=senf");

    const completed = logger.entries.filter((entry) => entry.event === "request_completed");
    const rejected = completed.at(-1);

    expect(rejected?.fields.errorCode).toBe("RATE_LIMITED");
    expect(rejected?.fields.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(logger.entries)).not.toContain("senf");
  });

  it("does not rate-limit the health endpoint", async () => {
    const { app } = createLimitedApp();
    await exhaustBudget(app);

    // A platform probe must keep succeeding while a noisy caller is being rejected.
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not rate-limit unknown routes into the wrong error code", async () => {
    const { app } = createLimitedApp();
    await exhaustBudget(app);

    const response = await request(app).get("/api/unknown");

    expect(response.status).toBe(404);
    expect(errorBody(response).code).toBe("NOT_FOUND");
  });
});

describe("GET /health", () => {
  it("still returns 200 and needs no upstream configuration", async () => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(calls).toHaveLength(0);
  });
});
