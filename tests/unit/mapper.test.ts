import { describe, expect, it } from "vitest";
import { mapSearchResponse } from "../../src/integrations/manufactum/mapper.js";
import type { UpstreamSearchResponse } from "../../src/integrations/manufactum/upstream-schema.js";

function upstreamAvailability(
  overrides: Partial<
    UpstreamSearchResponse["products"][number]["warehouse_availability"][number]
  > = {},
) {
  return {
    warehouse_id: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
    warehouse: "Manufactum Berlin",
    address: "Hardenbergstraße 4-5, 10623 Berlin",
    phone: "+49 30 24033844",
    opening_hours: { Montag: "10:00 - 20:00 Uhr", Sonntag: "Geschlossen" },
    status: "AVAILABLE",
    status_text: "Verfügbar",
    stock: 7,
    ...overrides,
  };
}

function upstreamResponse(
  availability: ReturnType<typeof upstreamAvailability>[],
): UpstreamSearchResponse {
  return {
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
        warehouse_availability: availability,
      },
    ],
  };
}

describe("mapSearchResponse", () => {
  it("maps AVAILABLE to in_stock and OUT_OF_STOCK to out_of_stock", () => {
    const { result, unmappedUpstreamStatuses } = mapSearchResponse(
      upstreamResponse([
        upstreamAvailability(),
        upstreamAvailability({ status: "OUT_OF_STOCK", status_text: "Nicht verfügbar", stock: 0 }),
      ]),
    );

    expect(result.products[0]?.availability.map((entry) => entry.status)).toEqual([
      "in_stock",
      "out_of_stock",
    ]);
    expect(unmappedUpstreamStatuses).toEqual([]);
  });

  it("maps an unrecognized status to unknown, reports it, and keeps stock unchanged", () => {
    const { result, unmappedUpstreamStatuses } = mapSearchResponse(
      upstreamResponse([upstreamAvailability({ status: "RESERVED_FOR_PICKUP", stock: 3 })]),
    );

    const entry = result.products[0]?.availability[0];

    expect(entry?.status).toBe("unknown");
    expect(entry?.stock).toBe(3);
    expect(unmappedUpstreamStatuses).toEqual(["RESERVED_FOR_PICKUP"]);
  });

  it.each(["available", "AVAILABLE ", "IN_STOCK", ""])(
    "never coerces the near-miss status %o into in_stock or out_of_stock",
    (status) => {
      const { result } = mapSearchResponse(upstreamResponse([upstreamAvailability({ status })]));

      expect(result.products[0]?.availability[0]?.status).toBe("unknown");
    },
  );

  it("carries priceText through byte-identically and never parses it", () => {
    const { result } = mapSearchResponse(upstreamResponse([]));

    expect(result.products[0]?.priceText).toBe("11,90 €");
  });

  it("does not expose manufacturer or status_text", () => {
    const { result } = mapSearchResponse(upstreamResponse([upstreamAvailability()]));

    const product = result.products[0];

    expect(product).not.toHaveProperty("manufacturer");
    expect(product?.availability[0]).not.toHaveProperty("status_text");
    expect(JSON.stringify(result)).not.toContain("Edmond Fallot");
    expect(JSON.stringify(result)).not.toContain("Verfügbar");
  });

  it("returns an empty availability array as-is, with no reason code", () => {
    const { result } = mapSearchResponse(upstreamResponse([]));

    expect(result.products[0]?.availability).toEqual([]);
    expect(Object.keys(result.products[0] ?? {})).toEqual([
      "sku",
      "name",
      "priceText",
      "description",
      "highlights",
      "productUrl",
      "availability",
    ]);
  });

  it("is pure: the same input maps to a deeply equal result and the input is not mutated", () => {
    const input = upstreamResponse([upstreamAvailability()]);
    const snapshot = structuredClone(input);

    expect(mapSearchResponse(input).result).toEqual(mapSearchResponse(input).result);
    expect(input).toEqual(snapshot);
  });

  it("maps an empty result set without inventing products", () => {
    const { result } = mapSearchResponse({ query: "xyzzy", result_count: 0, products: [] });

    expect(result).toEqual({ query: "xyzzy", resultCount: 0, products: [] });
  });
});
