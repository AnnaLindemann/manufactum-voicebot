# Domain Model

## Product

```ts
type Product = {
  id: string;
  articleNumber?: string;
  name: string;
  shortDescription?: string;
  price?: {
    amount: number;
    currency: string;
  };
  productUrl?: string;
  imageUrl?: string;
  source: "manufactum-api";
};
```

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
