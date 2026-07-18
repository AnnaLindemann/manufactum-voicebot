# Roadmap

## Phase 0 — Project Foundation

### Goal

Create a clean GitHub repository and local Node.js/TypeScript environment.

### Tasks

- create repository;
- clone into VS Code;
- run `npm init -y`;
- add TypeScript;
- add `.env.example`;
- add linting, formatting, and tests;
- create `/health`;
- add documentation;
- define branch and commit rules.

## Delivery Strategy

The project is implemented incrementally.

Roadmap phases describe technical implementation.

Customer demonstrations are organized as milestones.

Each milestone combines one or more roadmap phases into a demonstrable working solution.

Customer feedback is collected after every milestone before continuing development.

### Deliverable

A local project that starts successfully and passes a health-check test.

---

## Phase 1 — External API Discovery

### Goal

Determine what the real Manufactum API actually returns.

### Tests

- keyword search;
- exact product name;
- article number;
- partial word;
- typo;
- German umlauts;
- empty query;
- warehouse included and omitted;
- valid and invalid warehouse;
- different `limit` values;
- valid, missing, and invalid API key;
- no results;
- timeout;
- malformed response;
- price fields;
- stock fields;
- product IDs;
- URLs;
- images;
- alternatives;
- online availability;
- status codes and error bodies.

### Deliverable

`api-observation-report.md` with redacted sample responses and actual field meanings.

### Acceptance gate

No production integration design before the observed response format is understood.

---

## Phase 2 — Internal API Contracts

### Goal

Create a stable API for Dialfire, independent of the raw external API.

### Candidate endpoints

```text
GET /health
GET /api/products/search
GET /api/products/:productId
GET /api/products/:productId/availability
GET /api/products/:productId/alternatives
GET /api/stores
GET /api/stores/resolve
POST /api/reservations
GET /api/reservations/:reservationId
DELETE /api/reservations/:reservationId
POST /api/links/send
POST /api/rag/query
```

Only endpoints supported by real external capabilities are implemented.

### Deliverable

Reviewed API contracts and validation schemas.

---

## Phase 3 — Product Search, Price, and Availability

### Tasks

- normalize raw API responses;
- search by keyword;
- search by article number;
- limit results;
- return current price;
- return selected-store availability;
- return other-store availability;
- return online availability when supported;
- return product URL when supported;
- handle ambiguity and no results;
- add tests and logs.

### Deliverable

Working product-search backend.

---

## Phase 4 — Store Resolution

### Supported input

- city;
- postal code;
- exact address;
- store phone number;
- known store name;
- coordinates, only when supplied externally.

### Important limitation

A phone call does not automatically provide a postal code or exact location.

The bot must ask for city, postal code, or preferred store.

Nearest-store search requires a store registry with coordinates or an approved geocoding service.

### Tasks

- create store registry;
- map external warehouse IDs;
- normalize phone numbers;
- resolve city and postal code;
- rank stores by distance when possible;
- handle multiple matches;
- create clarification flow.

### Deliverable

Reliable store-resolution service.

---

## Phase 5 — Alternatives

### Tasks

- determine whether alternatives are returned by the external API;
- otherwise define safe internal search rules;
- distinguish exact matches from similar products;
- show at most two useful alternatives;
- offer another store, online shop, or human adviser.

### Deliverable

Alternative-product workflow.

---

## Phase 6 — Reservations

### Tasks

- inspect reservation API;
- document required customer data;
- validate product, store, and quantity;
- confirm before creation;
- create reservation;
- return reference and expiry;
- retrieve reservation;
- confirm before cancellation;
- cancel reservation;
- handle duplicates, timeout, expired, and already-cancelled cases.

### Deliverable

Reservation lifecycle API.

---

## Phase 7 — Public Test Deployment

### Goal

Make the backend reachable by Dialfire and testers.

### Tasks

- choose Node.js hosting;
- create test environment;
- configure HTTPS;
- configure secrets;
- configure logs and health checks;
- connect GitHub deployment;
- separate test and production credentials;
- define rollback.

### Deliverable

Public test URL with `/health`.

---

## Phase 8 — Dialfire Integration

### Tasks

- create JavaScript API wrapper;
- expose only prompt-visible functions;
- implement timeouts;
- map backend errors to short voice responses;
- use `temp` for transient data;
- store only required final fields in `data`;
- implement transfer and hangup;
- test real calls.

### Deliverable

Dialfire agent using the deployed backend.

---

## Phase 9 — Conversation Design

### Required scenarios

- exact product known;
- article number known;
- product partially known;
- product described by use;
- no result;
- store known;
- store unknown;
- search by city;
- search by postal code;
- product unavailable;
- other store;
- online shop;
- alternative product;
- reservation;
- cancellation;
- customer wants to order;
- link delivery;
- angry customer;
- human transfer;
- API failure;
- silence;
- interruption;
- unsupported request.

### Deliverable

Versioned conversation specification and tested prompt.

---

## Phase 10 — RAG Source Discovery

### Tasks

- create approved URL list;
- inspect sitemap;
- classify website pages;
- exclude catalogue pages handled by API;
- define source owner;
- define refresh frequency;
- create source registry.

### Deliverable

Approved source registry.

---

## Phase 11 — RAG Ingestion and Versioning

### Tasks

- fetch HTML;
- extract main content;
- remove navigation, footer, cookies, scripts, and repeated blocks;
- normalize text;
- calculate content hash;
- create immutable document versions;
- create change summary;
- chunk by section;
- assign document version to every chunk;
- calculate chunk hash;
- create embeddings;
- store in PostgreSQL with pgvector;
- activate new version;
- retain old versions.

### Required metadata

Every chunk must include:

- stable document ID;
- document version;
- chunk index;
- chunk hash;
- source URL;
- ingestion time;
- active status.

### Deliverable

Versioned RAG database.

---

## Phase 12 — RAG Retrieval API

### Tasks

- semantic search;
- metadata filters;
- active-version filter;
- source attribution;
- confidence threshold;
- no-answer fallback;
- short voice-ready context;
- retrieval logs.

### Deliverable

`POST /api/rag/query`.

---

## Phase 13 — RAG Synchronization

### MVP

- scheduled crawl;
- content-hash comparison;
- update changed pages only;
- retries;
- update history.

### Preferred production option

- CMS API;
- CMS webhook;
- page-level update event;
- reindex only changed content.

### Deliverable

Incremental synchronization.

---

## Phase 14 — Link Delivery

### Candidate channels

- e-mail;
- SMS;
- WhatsApp;
- Telegram only when explicitly supported and approved.

### Tasks

- collect destination;
- confirm destination;
- obtain consent;
- send approved link;
- log delivery status;
- handle failure.

### Deliverable

Outbound link-delivery service.

---

## Phase 15 — End-to-End Testing

### Areas

- product search;
- price;
- stock;
- other stores;
- online availability;
- alternatives;
- reservation;
- cancellation;
- store resolution;
- RAG;
- transfer;
- errors;
- privacy;
- latency;
- version traceability;
- voice usability.

### Deliverable

Acceptance report.

---

## Phase 16 — Production Preparation

### Tasks

- production credentials;
- production phone numbers;
- caller ID;
- monitoring;
- alerts;
- backups;
- rate limiting;
- security review;
- privacy review;
- operational support;
- rollback;
- handover documentation.

### Deliverable

Production deployment package.
