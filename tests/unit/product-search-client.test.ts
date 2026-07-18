import { describe, expect, it } from "vitest";
import type { AppError } from "../../src/errors/app-error.js";
import { createProductSearchClient } from "../../src/integrations/manufactum/product-search-client.js";
import {
  createFetchStub,
  createRecordingContext,
  createRecordingLogger,
  jsonResponse,
  TEST_CONFIG,
} from "../helpers/test-doubles.js";

const VALID_BODY = {
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
      highlights: [],
      warehouse_availability: [],
    },
  ],
};

function createClient(response: Response | (() => Promise<Response>)) {
  const logger = createRecordingLogger();
  const { fetchImplementation, calls } = createFetchStub(response);

  const client = createProductSearchClient({
    loadConfig: () => TEST_CONFIG,
    fetchImplementation,
    logger,
  });

  return { client, calls, logger };
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught as AppError,
  );

  expect(error?.code).toBe(code);
  return error as AppError;
}

describe("createProductSearchClient", () => {
  it("sends q and limit, and sends warehouse only when supplied", async () => {
    const { client, calls } = createClient(jsonResponse(VALID_BODY));

    await client({ q: "senf", limit: 5 }, createRecordingContext("cid-1"));
    await client(
      { q: "senf", warehouseId: "493024033844", limit: 2 },
      createRecordingContext("cid-2"),
    );

    expect(calls[0]?.url.pathname).toBe("/search");
    expect(calls[0]?.url.searchParams.get("q")).toBe("senf");
    // limit is always explicit, so the result count never depends on an unobserved upstream default.
    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
    expect(calls[0]?.url.searchParams.has("warehouse")).toBe(false);
    expect(calls[1]?.url.searchParams.get("warehouse")).toBe("493024033844");
  });

  it("authenticates with the configured header", async () => {
    const { client, calls } = createClient(jsonResponse(VALID_BODY));

    await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    expect(calls[0]?.init?.headers).toEqual({ "x-api-key": TEST_CONFIG.apiKey });
  });

  it("maps upstream 403 to UPSTREAM_AUTH_FAILED without forwarding status or body", async () => {
    const { client, logger } = createClient(jsonResponse({ message: "Forbidden" }, 403));

    const error = await expectErrorCode(
      client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
      "UPSTREAM_AUTH_FAILED",
    );

    expect(error.status).toBe(502);
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(logger.entries)).not.toContain("Forbidden");
  });

  it("maps upstream 400 to UPSTREAM_REJECTED_REQUEST", async () => {
    const { client, logger } = createClient(
      jsonResponse({ error: "Query parameter 'q' is required" }, 400),
    );

    const error = await expectErrorCode(
      client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
      "UPSTREAM_REJECTED_REQUEST",
    );

    expect(error.status).toBe(502);
    expect(JSON.stringify(logger.entries)).not.toContain("Query parameter");
  });

  it.each([500, 429, 503, 418])(
    "maps unexpected upstream status %i to UPSTREAM_UNAVAILABLE",
    async (status) => {
      const { client } = createClient(jsonResponse({}, status));

      const error = await expectErrorCode(
        client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
        "UPSTREAM_UNAVAILABLE",
      );

      expect(error.status).toBe(502);
      expect(error.retryable).toBe(true);
    },
  );

  it("maps a connection failure or abort to a retryable UPSTREAM_TIMEOUT", async () => {
    const { client } = createClient(() => Promise.reject(new Error("The operation was aborted")));

    const error = await expectErrorCode(
      client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
      "UPSTREAM_TIMEOUT",
    );

    expect(error.status).toBe(504);
    expect(error.retryable).toBe(true);
  });

  it("rejects a non-JSON body as UPSTREAM_INVALID_RESPONSE", async () => {
    const { client } = createClient(new Response("<html>gateway</html>", { status: 200 }));

    await expectErrorCode(
      client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
      "UPSTREAM_INVALID_RESPONSE",
    );
  });

  it.each([
    ["a missing mapped field", { query: "senf", result_count: 1, products: [{ sku: "1" }] }],
    ["a wrongly typed mapped field", { query: "senf", result_count: "1", products: [] }],
    ["a missing top-level field", { result_count: 0, products: [] }],
  ])(
    "rejects %s as UPSTREAM_INVALID_RESPONSE rather than mapping partially",
    async (_label, body) => {
      const { client } = createClient(jsonResponse(body));

      await expectErrorCode(
        client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
        "UPSTREAM_INVALID_RESPONSE",
      );
    },
  );

  // Every field the public contract maps stays load-bearing: dropping any one of them must fail the
  // whole response rather than let a product be spoken with a missing price or stock value.
  it.each(["price", "sku", "name", "description", "product_url", "highlights"])(
    "rejects a product missing the mapped field %s",
    async (field) => {
      const product = { ...VALID_BODY.products[0] } as Record<string, unknown>;
      delete product[field];

      const { client } = createClient(jsonResponse({ ...VALID_BODY, products: [product] }));

      await expectErrorCode(
        client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
        "UPSTREAM_INVALID_RESPONSE",
      );
    },
  );

  it.each(["warehouse_id", "warehouse", "address", "phone", "opening_hours", "status", "stock"])(
    "rejects an availability entry missing the mapped field %s",
    async (field) => {
      const entry: Record<string, unknown> = {
        warehouse_id: "W1",
        warehouse: "Manufactum Berlin",
        address: null,
        phone: null,
        opening_hours: {},
        status: "AVAILABLE",
        status_text: "Verfügbar",
        stock: 1,
      };
      delete entry[field];

      const { client } = createClient(
        jsonResponse({
          ...VALID_BODY,
          products: [{ ...VALID_BODY.products[0], warehouse_availability: [entry] }],
        }),
      );

      await expectErrorCode(
        client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
        "UPSTREAM_INVALID_RESPONSE",
      );
    },
  );

  // manufacturer and status_text are not public-contract fields, so their absence must not fail a
  // response that can still answer the caller's question.
  it("maps successfully when manufacturer is absent", async () => {
    const product = { ...VALID_BODY.products[0] } as Record<string, unknown>;
    delete product.manufacturer;

    const { client } = createClient(jsonResponse({ ...VALID_BODY, products: [product] }));

    const result = await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    expect(result.products[0]?.name).toBe("Moutarde de Dijon");
    expect(result.products[0]).not.toHaveProperty("manufacturer");
  });

  it("maps successfully when status_text is absent", async () => {
    const { client } = createClient(
      jsonResponse({
        ...VALID_BODY,
        products: [
          {
            ...VALID_BODY.products[0],
            warehouse_availability: [
              {
                warehouse_id: "W1",
                warehouse: "Manufactum Berlin",
                address: null,
                phone: null,
                opening_hours: {},
                status: "AVAILABLE",
                stock: 4,
              },
            ],
          },
        ],
      }),
    );

    const result = await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    expect(result.products[0]?.availability[0]?.status).toBe("in_stock");
    expect(result.products[0]?.availability[0]?.stock).toBe(4);
  });

  it("maps successfully when both manufacturer and status_text are absent", async () => {
    const product = { ...VALID_BODY.products[0] } as Record<string, unknown>;
    delete product.manufacturer;
    product.warehouse_availability = [
      {
        warehouse_id: "W1",
        warehouse: "Manufactum Berlin",
        address: null,
        phone: null,
        opening_hours: {},
        status: "OUT_OF_STOCK",
        stock: 0,
      },
    ];

    const { client } = createClient(jsonResponse({ ...VALID_BODY, products: [product] }));

    const result = await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    expect(result.products[0]?.availability[0]?.status).toBe("out_of_stock");
  });

  // Optional does not mean unvalidated: a type change in either field is still a shape change.
  it.each([
    ["manufacturer", { ...VALID_BODY.products[0], manufacturer: 42 }],
    [
      "status_text",
      {
        ...VALID_BODY.products[0],
        warehouse_availability: [
          {
            warehouse_id: "W1",
            warehouse: "Manufactum Berlin",
            address: null,
            phone: null,
            opening_hours: {},
            status: "AVAILABLE",
            status_text: 7,
            stock: 1,
          },
        ],
      },
    ],
  ])("still rejects a wrongly typed %s", async (_label, product) => {
    const { client } = createClient(jsonResponse({ ...VALID_BODY, products: [product] }));

    await expectErrorCode(
      client({ q: "senf", limit: 5 }, createRecordingContext("cid")),
      "UPSTREAM_INVALID_RESPONSE",
    );
  });

  it("ignores unknown additional upstream fields", async () => {
    const { client } = createClient(
      jsonResponse({
        ...VALID_BODY,
        pagination: { next: "cursor" },
        products: [{ ...VALID_BODY.products[0], image_url: "https://example.test/a.jpg" }],
      }),
    );

    const result = await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    expect(result.products[0]).not.toHaveProperty("image_url");
    expect(result).not.toHaveProperty("pagination");
  });

  it("logs the raw upstream status value when it maps to unknown", async () => {
    const { client, logger } = createClient(
      jsonResponse({
        ...VALID_BODY,
        products: [
          {
            ...VALID_BODY.products[0],
            warehouse_availability: [
              {
                warehouse_id: "W1",
                warehouse: "Manufactum Berlin",
                address: null,
                phone: null,
                opening_hours: {},
                status: "RESERVED_FOR_PICKUP",
                status_text: "Reserviert",
                stock: 2,
              },
            ],
          },
        ],
      }),
    );

    await client({ q: "senf", limit: 5 }, createRecordingContext("cid-unknown"));

    const entry = logger.entries.find((line) => line.event === "upstream_status_unmapped");

    expect(entry?.fields.correlationId).toBe("cid-unknown");
    expect(entry?.fields.unmappedUpstreamStatuses).toEqual(["RESERVED_FOR_PICKUP"]);
  });

  it("never logs the API key, the auth header value, or a raw upstream body", async () => {
    const { client, logger } = createClient(jsonResponse(VALID_BODY));

    await client({ q: "senf", limit: 5 }, createRecordingContext("cid"));

    const logged = JSON.stringify(logger.entries);

    expect(logged).not.toContain(TEST_CONFIG.apiKey);
    expect(logged).not.toContain("Moutarde de Dijon");
    expect(logged).not.toContain("11,90");
  });

  it("logs correlation ID, upstream status, latency, and result count on success", async () => {
    const { client, logger } = createClient(jsonResponse(VALID_BODY));

    await client({ q: "senf", limit: 5 }, createRecordingContext("cid-ok"));

    const entry = logger.entries.find((line) => line.event === "upstream_request_completed");

    expect(entry?.fields.correlationId).toBe("cid-ok");
    expect(entry?.fields.upstreamStatus).toBe(200);
    expect(entry?.fields.resultCount).toBe(1);
    expect(typeof entry?.fields.upstreamLatencyMs).toBe("number");
  });
});
