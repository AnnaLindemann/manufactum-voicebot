import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
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
function createTestApp(upstream: Response | (() => Promise<Response>)) {
  const logger = createRecordingLogger();
  const { fetchImplementation, calls } = createFetchStub(upstream);

  const app = createApp({
    logger,
    productSearchService: createProductSearchService(
      createProductSearchClient({ loadConfig: () => TEST_CONFIG, fetchImplementation, logger }),
    ),
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

describe("GET /api/products/search", () => {
  it("returns 200 with the mapped internal model", async () => {
    const { app } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      query: "senf",
      resultCount: 1,
      warehouseFilterApplied: false,
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

  it("sets warehouseFilterApplied only when a warehouseId was supplied", async () => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const withWarehouse = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "493024033844" });
    const withoutWarehouse = await request(app).get("/api/products/search").query({ q: "senf" });

    expect(successBody(withWarehouse).warehouseFilterApplied).toBe(true);
    expect(successBody(withoutWarehouse).warehouseFilterApplied).toBe(false);
    expect(calls[0]?.url.searchParams.get("warehouse")).toBe("493024033844");
    expect(calls[1]?.url.searchParams.has("warehouse")).toBe(false);
  });

  it("returns 200 with resultCount 0 for a no-match query, not an error", async () => {
    const { app } = createTestApp(jsonResponse({ query: "xyzzy", result_count: 0, products: [] }));

    const response = await request(app).get("/api/products/search").query({ q: "xyzzy" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      query: "xyzzy",
      resultCount: 0,
      warehouseFilterApplied: false,
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

    const response = await request(app)
      .get("/api/products/search")
      .query({ q: "senf", warehouseId: "unknown-warehouse" });

    expect(response.status).toBe(200);
    expect(successBody(response).products[0]?.availability).toEqual([]);
    // warehouseFilterApplied and the empty array are the only two signals. Nothing explains why.
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

describe("GET /health", () => {
  it("still returns 200 and needs no upstream configuration", async () => {
    const { app, calls } = createTestApp(jsonResponse(UPSTREAM_BODY));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(calls).toHaveLength(0);
  });
});
