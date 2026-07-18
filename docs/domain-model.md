# Domain Model

## Scope note

This document describes the intended domain across all roadmap phases. It is broader than what any
single phase implements.

The MVP product-search contract in `api-contracts.md` is narrower than the models below. Where the
two differ, **`api-contracts.md` is authoritative for the MVP**, because it is derived from observed
evidence. The differences are recorded under each model.

## Product

```ts
type Product = {
  id: string;
  articleNumber?: string;
  name: string;
  shortDescription?: string;
  priceText?: string;
  productUrl?: string;
  imageUrl?: string;
  source: "manufactum-api";
};
```

### MVP differences

- `priceText` replaces the earlier `price: { amount, currency }`. The upstream price was observed only
  as a localized string such as `"11,90 €"`, and the MVP does not parse it into a number. See
  `D-015`.
- The MVP contract exposes `sku`, `name`, `priceText`, `description`, `highlights`, `productUrl`, and
  `availability`.
- `id` is not populated in the MVP; upstream returns `sku`, and no separate product identifier was
  observed.
- `imageUrl` is not populated in the MVP. No image field was observed upstream.
- `highlights`, observed upstream as an array of strings, has no equivalent here because it is
  specific to the search response rather than to the domain product.

## Store

```ts
type Store = {
  id: string;
  externalWarehouseId: string;
  name: string;
  city: string;
  postalCode?: string;
  address?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
  source: "api" | "website" | "manual-registry";
};
```

## Availability

```ts
type Availability = {
  productId: string;
  storeId?: string;
  channel: "physical_store" | "online_shop";
  status: "in_stock" | "low_stock" | "out_of_stock" | "unknown";
  quantity?: number;
  checkedAt: string;
  source: "manufactum-api";
};
```

### MVP differences

- The MVP contract exposes `warehouseId`, `warehouseName`, `address`, `phone`, `openingHours`,
  `status`, and `stock`.
- `status` is populated with three of the four values above. `in_stock` and `out_of_stock` come from
  the observed upstream values `AVAILABLE` and `OUT_OF_STOCK`. `unknown` is a defensive mapping for an
  unrecognized upstream status; it is logged and must never be spoken as stock information.
- `low_stock` is **not** populated in the MVP. No observed upstream value produces it.
- `channel` is not populated. Only physical-store availability was observed; online-shop availability
  was never confirmed to exist.
- `productId` and `storeId` are not populated. There is no internal product identifier and no store
  registry; the store registry arrives in Phase 4.
- `checkedAt` is not part of the MVP response. Request timing is recorded in correlation logs
  instead. See `D-015`.
- An empty availability list never means out of stock. It means only that no availability entries were
  returned. See `api-contracts.md`.

## Reservation

```ts
type Reservation = {
  id: string;
  productId: string;
  storeId: string;
  quantity: number;
  customer: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  };
  status: "pending" | "confirmed" | "cancelled" | "expired" | "failed";
  createdAt: string;
  expiresAt?: string;
  externalReference?: string;
};
```

## KnowledgeDocument

```ts
type KnowledgeDocument = {
  id: string;
  documentKey: string;
  sourceUrl: string;
  title: string;
  documentType: string;
  currentVersion: number;
  contentHash: string;
  status: "active" | "inactive" | "failed";
  lastCrawledAt: string;
  lastChangedAt?: string;
};
```

## KnowledgeDocumentVersion

```ts
type KnowledgeDocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  rawContent: string;
  normalizedContent: string;
  contentHash: string;
  changeSummary?: string;
  createdAt: string;
  isActive: boolean;
};
```

## KnowledgeChunk

```ts
type KnowledgeChunk = {
  id: string;
  documentId: string;
  documentVersion: number;
  chunkIndex: number;
  chunkKey: string;
  content: string;
  contentHash: string;
  embedding: number[];
  sourceUrl: string;
  createdAt: string;
  isActive: boolean;
};
```
