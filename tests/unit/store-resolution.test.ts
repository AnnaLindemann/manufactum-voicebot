import { describe, expect, it } from "vitest";
import type { Availability, Product } from "../../src/domain/product-search.js";
import {
  collectStores,
  filterAvailabilityToStore,
  normalizeStoreText,
  resolveStoreSelection,
} from "../../src/domain/store-resolution.js";

function availability(
  warehouseId: string,
  warehouseName: string,
  address: string | null,
): Availability {
  return {
    warehouseId,
    warehouseName,
    address,
    phone: null,
    openingHours: {},
    status: "in_stock",
    stock: 1,
  };
}

const BERLIN_HARDENBERG = availability(
  "MANUFACTUM_BERLIN_HAUS_HADENBERG",
  "Manufactum Berlin",
  "Hardenbergstraße 4-5, 10623 Berlin",
);
const BERLIN_KGA = availability(
  "MANUFACTUM_BERLIN_KGA",
  "Manufactum Berlin KaDeWe",
  "Tauentzienstraße 21-24, 10789 Berlin",
);
const MUNICH = availability(
  "MANUFACTUM_MUENCHEN",
  "Manufactum München",
  "Dienerstraße 12, 80331 München",
);

function product(name: string, entries: Availability[]): Product {
  return {
    sku: name,
    name,
    priceText: null,
    description: null,
    highlights: [],
    productUrl: null,
    availability: entries,
  };
}

const PRODUCTS = [product("senf", [BERLIN_HARDENBERG, BERLIN_KGA, MUNICH])];

describe("normalizeStoreText", () => {
  it("folds case and collapses punctuation to single spaces", () => {
    expect(normalizeStoreText("  Manufactum  BERLIN-KaDeWe, 10789 ")).toBe(
      "manufactum berlin kadewe 10789",
    );
  });

  it.each([
    ["München", "muenchen"],
    ["Muenchen", "muenchen"],
    ["Köln", "koeln"],
    ["Straße", "strasse"],
  ])("expands the German %s to %s so both spellings match", (input, expected) => {
    expect(normalizeStoreText(input)).toBe(expected);
  });

  it("strips non-German diacritics rather than expanding them", () => {
    expect(normalizeStoreText("Café")).toBe("cafe");
  });
});

describe("collectStores", () => {
  it("deduplicates a store reached through several products", () => {
    const stores = collectStores([
      product("a", [BERLIN_HARDENBERG, MUNICH]),
      product("b", [BERLIN_HARDENBERG]),
    ]);

    expect(stores.map((store) => store.storeId)).toEqual([
      "MANUFACTUM_BERLIN_HAUS_HADENBERG",
      "MANUFACTUM_MUENCHEN",
    ]);
  });

  it("projects only the minimal store identity, carrying no stock information", () => {
    expect(collectStores([product("a", [BERLIN_HARDENBERG])])).toEqual([
      {
        storeId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
        warehouseName: "Manufactum Berlin",
        address: "Hardenbergstraße 4-5, 10623 Berlin",
      },
    ]);
  });

  it("returns no stores for a response with no products", () => {
    expect(collectStores([])).toEqual([]);
  });
});

describe("resolveStoreSelection", () => {
  it("reports not_requested and selects nothing when neither parameter is given", () => {
    expect(resolveStoreSelection(PRODUCTS, {})).toEqual({
      resolution: { status: "not_requested" },
      selectedStoreId: null,
    });
  });

  it("matches an exact storeId without echoing a query", () => {
    const { resolution, selectedStoreId } = resolveStoreSelection(PRODUCTS, {
      storeId: "MANUFACTUM_BERLIN_KGA",
    });

    expect(selectedStoreId).toBe("MANUFACTUM_BERLIN_KGA");
    expect(resolution).toEqual({
      status: "matched",
      selectedStore: {
        storeId: "MANUFACTUM_BERLIN_KGA",
        warehouseName: "Manufactum Berlin KaDeWe",
        address: "Tauentzienstraße 21-24, 10789 Berlin",
      },
    });
    // `query` belongs to a `store` lookup; an exact identifier was not a text query.
    expect(resolution).not.toHaveProperty("query");
  });

  it("reports not_found for a storeId absent from the response", () => {
    expect(resolveStoreSelection(PRODUCTS, { storeId: "MANUFACTUM_NOWHERE" })).toEqual({
      resolution: { status: "not_found" },
      selectedStoreId: null,
    });
  });

  it("is case-insensitive about an exact storeId only in its own exact form", () => {
    // The identifier is technical and compared verbatim, unlike the human-readable `store` query.
    expect(
      resolveStoreSelection(PRODUCTS, { storeId: "manufactum_berlin_kga" }).resolution.status,
    ).toBe("not_found");
  });

  it("reports ambiguous with every candidate when a city has several branches", () => {
    const { resolution, selectedStoreId } = resolveStoreSelection(PRODUCTS, { store: "Berlin" });

    expect(selectedStoreId).toBeNull();
    expect(resolution).toEqual({
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
  });

  it.each([["München"], ["muenchen"], ["MUENCHEN"]])(
    "matches the single Munich branch for the spelling %s",
    (store) => {
      const { resolution, selectedStoreId } = resolveStoreSelection(PRODUCTS, { store });

      expect(selectedStoreId).toBe("MANUFACTUM_MUENCHEN");
      expect(resolution).toMatchObject({
        status: "matched",
        query: store,
        selectedStore: { storeId: "MANUFACTUM_MUENCHEN" },
      });
    },
  );

  it("matches on the address as well as the name", () => {
    expect(resolveStoreSelection(PRODUCTS, { store: "Tauentzienstraße" }).resolution).toMatchObject(
      { status: "matched", selectedStore: { storeId: "MANUFACTUM_BERLIN_KGA" } },
    );
  });

  it("reports not_found for a store query nothing matches", () => {
    expect(resolveStoreSelection(PRODUCTS, { store: "Hamburg" })).toEqual({
      resolution: { status: "not_found", query: "Hamburg" },
      selectedStoreId: null,
    });
  });

  it("matches whole tokens only, so a shorter city name is not a prefix match", () => {
    // "Bern" must not reach "Berlin": offering the wrong branch is the failure this prevents.
    expect(resolveStoreSelection(PRODUCTS, { store: "Bern" }).resolution.status).toBe("not_found");
  });

  it("reports not_found rather than throwing when no product came back", () => {
    expect(resolveStoreSelection([], { store: "Berlin" }).resolution).toEqual({
      status: "not_found",
      query: "Berlin",
    });
  });

  it("prefers storeId when both are somehow present, though validation rejects that pairing", () => {
    // Defence in depth: the resolver is total, so it still behaves predictably if validation is
    // ever bypassed. The HTTP boundary rejects this combination with INVALID_REQUEST.
    expect(
      resolveStoreSelection(PRODUCTS, { store: "Hamburg", storeId: "MANUFACTUM_BERLIN_KGA" })
        .selectedStoreId,
    ).toBe("MANUFACTUM_BERLIN_KGA");
  });
});

describe("filterAvailabilityToStore", () => {
  it("keeps only the selected store's entry", () => {
    const filtered = filterAvailabilityToStore(PRODUCTS, "MANUFACTUM_BERLIN_KGA");

    expect(filtered[0]?.availability).toEqual([BERLIN_KGA]);
  });

  it("leaves an empty array for a product the store does not carry", () => {
    const filtered = filterAvailabilityToStore(
      [product("senf", [MUNICH])],
      "MANUFACTUM_BERLIN_KGA",
    );

    expect(filtered[0]?.availability).toEqual([]);
  });

  it("never removes a product, so the result count is untouched", () => {
    const products = [product("a", [MUNICH]), product("b", [BERLIN_KGA])];

    expect(filterAvailabilityToStore(products, "MANUFACTUM_BERLIN_KGA")).toHaveLength(2);
  });

  it("does not mutate the products it was given", () => {
    const products = [product("senf", [BERLIN_KGA, MUNICH])];

    filterAvailabilityToStore(products, "MANUFACTUM_BERLIN_KGA");

    expect(products[0]?.availability).toHaveLength(2);
  });
});
