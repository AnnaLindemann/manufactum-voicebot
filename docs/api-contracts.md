# Internal API Contracts

These contracts are provisional until API discovery is complete.

## GET /health

Returns service status.

## GET /api/products/search

### Query

```text
q
storeId
limit
mode
```

### Response

```json
{
  "query": "senf",
  "matches": [],
  "selectedStore": null,
  "onlineAvailabilitySupported": false,
  "ambiguity": "none"
}
```

## GET /api/stores/resolve

### Query

```text
city
postalCode
phone
query
```

### Response

```json
{
  "matches": [],
  "resolution": "none"
}
```

## POST /api/reservations

### Body

```json
{
  "productId": "...",
  "storeId": "...",
  "quantity": 1,
  "customer": {
    "firstName": "...",
    "lastName": "...",
    "phone": "...",
    "email": "..."
  },
  "confirmed": true
}
```

## POST /api/rag/query

### Body

```json
{
  "question": "...",
  "language": "de",
  "documentTypes": ["returns"],
  "maxChunks": 5
}
```

### Response

```json
{
  "answerContext": "...",
  "sources": [
    {
      "documentKey": "returns-policy",
      "documentVersion": 4,
      "chunkKey": "returns-policy:v4:chunk-002",
      "sourceUrl": "https://www.manufactum.de/..."
    }
  ],
  "confidence": 0.82
}
```
