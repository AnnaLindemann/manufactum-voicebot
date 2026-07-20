import type { Product, SelectedStore, Store, StoreResolution } from "./product-search.js";

/**
 * Store selection for `GET /api/products/search`, per `api-contracts.md` § Store selection.
 *
 * Resolution is **local**: the store universe is the set of stores present in the availability
 * entries of the upstream response, and no store parameter is sent upstream. That is what makes
 * `ambiguous` and `not_found` expressible at all — a request filtered upstream comes back with the
 * non-matching stores already gone, leaving nothing to disambiguate against.
 *
 * Total and pure: it does not throw, does not perform I/O, and does not read the clock.
 */

export type StoreSelector = {
  store?: string;
  storeId?: string;
};

export type ResolvedSelection = {
  resolution: StoreResolution;
  /**
   * The store to filter `availability` down to, or `null` to leave it untouched. Non-null only for
   * `matched`: an unresolved selection must never look like a filtered one.
   */
  selectedStoreId: string | null;
};

const GERMAN_SUBSTITUTIONS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/**
 * Folds a store query and a store's own text onto one comparable form: lowercase, German umlauts
 * expanded the way German itself expands them (`ä` → `ae`), remaining diacritics stripped, and every
 * run of non-alphanumerics collapsed to a single space.
 *
 * The umlaut expansion runs before the diacritic strip on purpose. Stripping first would turn `ä`
 * into `a`, so `München` and `Muenchen` would normalize to `munchen` and `muenchen` and fail to
 * match. Upstream was observed to treat the two spellings of `Bewässerungstopf` as the same query
 * (EXP-015, EXP-016), so a caller may reasonably use either.
 */
export function normalizeStoreText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[äöüß]/g, (character) => GERMAN_SUBSTITUTIONS[character] ?? character)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every distinct store appearing in the response, in order of first appearance, deduplicated by
 * `warehouseId`.
 *
 * Deduplication is by identifier alone: the same store reached through two products is one store,
 * and a caller offered the same branch twice would read it as two branches. First appearance also
 * wins for the store's own details — the same branch reached through two products is expected to
 * carry the same address, phone, and opening hours, and nothing here reconciles them if it does
 * not.
 *
 * The projection deliberately stops at the place: `status` and `stock` describe one product at a
 * store and are left in `availability`, where a consumer has to check `storeResolution` first to
 * read them safely.
 */
export function collectStores(products: Product[]): SelectedStore[] {
  const storesById = new Map<string, SelectedStore>();

  for (const product of products) {
    for (const entry of product.availability) {
      if (!storesById.has(entry.warehouseId)) {
        storesById.set(entry.warehouseId, {
          storeId: entry.warehouseId,
          warehouseName: entry.warehouseName,
          address: entry.address,
          phone: entry.phone,
          openingHours: entry.openingHours,
        });
      }
    }
  }

  return [...storesById.values()];
}

/**
 * Narrows a store to the identity a caller needs while they are still choosing between branches.
 *
 * An `ambiguous` outcome asks exactly one question — which branch do you mean — and name and
 * address answer it. Contact details for several branches at once are data the caller cannot act on
 * until they have chosen, and every field handed to a consumer is a field it may end up speaking.
 */
function toCandidate({ storeId, warehouseName, address }: SelectedStore): Store {
  return { storeId, warehouseName, address };
}

/**
 * Whole-token containment, not raw substring containment.
 *
 * Both sides are padded with spaces so `berlin` matches `manufactum berlin` and
 * `hardenbergstrasse 4 5 10623 berlin` but not `bernkastel`. A raw substring test would let a short
 * query bleed into unrelated names, and offering a caller the wrong branch is the failure this
 * whole resolution step exists to prevent.
 */
function matchesQuery(store: Store, normalizedQuery: string): boolean {
  const haystack = normalizeStoreText(`${store.warehouseName} ${store.address ?? ""}`);

  return ` ${haystack} `.includes(` ${normalizedQuery} `);
}

export function resolveStoreSelection(
  products: Product[],
  { store, storeId }: StoreSelector,
): ResolvedSelection {
  if (storeId !== undefined) {
    const selectedStore = collectStores(products).find(
      (candidate) => candidate.storeId === storeId,
    );

    // No such store in this response. Reported as an unresolved selection, never as a product that
    // is missing from the store: nothing here observed the store's stock at all.
    if (selectedStore === undefined) {
      return { resolution: { status: "not_found" }, selectedStoreId: null };
    }

    return { resolution: { status: "matched", selectedStore }, selectedStoreId: storeId };
  }

  if (store !== undefined) {
    const normalizedQuery = normalizeStoreText(store);
    const candidates = collectStores(products).filter((candidate) =>
      matchesQuery(candidate, normalizedQuery),
    );

    const [only] = candidates;

    if (only === undefined) {
      return { resolution: { status: "not_found", query: store }, selectedStoreId: null };
    }

    if (candidates.length > 1) {
      return {
        resolution: { status: "ambiguous", query: store, candidates: candidates.map(toCandidate) },
        selectedStoreId: null,
      };
    }

    return {
      resolution: { status: "matched", query: store, selectedStore: only },
      selectedStoreId: only.storeId,
    };
  }

  return { resolution: { status: "not_requested" }, selectedStoreId: null };
}

/**
 * Narrows every product's `availability` to the selected store, leaving an empty array for a product
 * that store does not carry.
 *
 * An empty array keeps its contracted meaning — "no availability entries were returned" — and is
 * still never an out-of-stock claim.
 */
export function filterAvailabilityToStore(products: Product[], storeId: string): Product[] {
  return products.map((product) => ({
    ...product,
    availability: product.availability.filter((entry) => entry.warehouseId === storeId),
  }));
}
