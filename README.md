# Manufactum Voicebot Integration

## Project purpose

This project creates a custom Node.js backend for a Dialfire AI voice agent for Manufactum.

The assistant should help customers with:

- product search by name, keyword, description, or article number;
- current price;
- availability in a selected physical store;
- availability in other stores;
- online-shop availability, if exposed by the client API;
- alternative products;
- reservation creation;
- reservation lookup;
- reservation cancellation;
- store search by city, postal code, phone number, or address;
- human transfer;
- later: sending product, store, or FAQ links by e-mail, SMS, or WhatsApp;
- later: FAQ answers through a versioned RAG knowledge base.

## Core architecture rule

Transactional and frequently changing data must come from APIs in real time.

Examples:

- price;
- stock;
- store availability;
- reservation status;
- order status;
- alternatives returned by the product system.

Stable explanatory information belongs in RAG.

Examples:

- delivery;
- Click & Collect;
- returns;
- complaints;
- payment methods;
- vouchers;
- customer card;
- store services;
- general FAQ.

## System responsibilities

### Dialfire

- voice conversation;
- intent recognition;
- function calls;
- transfer and hangup;
- short conversation context.

### Custom backend

- API authentication;
- validation;
- normalization of external responses;
- business rules;
- store resolution;
- reservation workflows;
- RAG ingestion;
- document and chunk versioning;
- vector search;
- logging and health checks.

## Initial development order

1. Create GitHub repository.
2. Clone it into VS Code.
3. Run `npm init -y`.
4. Add TypeScript and basic tooling.
5. Create a small local API test script.
6. Inspect real API responses.
7. Document the observed API contract.
8. Design stable internal endpoints.
9. Implement one product-search endpoint.
10. Deploy a public HTTPS test backend.
11. Connect Dialfire.
12. Add reservations and store resolution.
13. Add website ingestion and RAG.
14. Test complete voice scenarios.

## Important clarification

Deployment is not needed for the first local API tests.

Deployment becomes necessary when:

- Dialfire must call the backend;
- another person must test it;
- a public demo is needed;
- scheduled RAG jobs must run outside the laptop.

## Suggested repository structure

```text
manufactum-voicebot/
├─ src/
│  ├─ app.ts
│  ├─ server.ts
│  ├─ config/
│  ├─ modules/
│  │  ├─ api-discovery/
│  │  ├─ products/
│  │  ├─ stores/
│  │  ├─ reservations/
│  │  ├─ rag/
│  │  └─ health/
│  ├─ shared/
│  └─ jobs/
├─ scripts/
│  ├─ test-search-api.ts
│  ├─ test-reservation-api.ts
│  └─ ingest-selected-pages.ts
├─ docs/
├─ tests/
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
```

## Initial commands

```bash
mkdir manufactum-voicebot
cd manufactum-voicebot
git init
npm init -y
npm install express dotenv zod
npm install -D typescript tsx @types/node @types/express eslint prettier vitest supertest @types/supertest
npx tsc --init
```

Do not add Supabase, Prisma, RAG, or deployment before the real search API response has been inspected and documented.

---

## Running the backend

Node **24** (`engines.node` is `^24.11.0`).

```bash
npm ci
cp .env.example .env     # then fill it in; see the comments in that file
npm run dev              # tsx watch, reloads on change
```

The server prints `Manufactum Voicebot backend is listening on port <PORT>` and exposes:

| Endpoint                   | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `GET /health`              | Liveness only. It proves the process is up — nothing more. See below.    |
| `GET /api/products/search` | Product search against the Manufactum API. Rate-limited: 20 req/min/IP.  |
| `POST /api/rag/query`      | Retrieval-only FAQ evidence from the versioned RAG store. 10 req/min/IP. |

```bash
curl -s "http://localhost:3000/health"

curl -s -X POST "http://localhost:3000/api/rag/query" \
  -H "content-type: application/json" \
  -d '{"query":"Welche Vorteile bietet mir ein Konto?"}'
```

`query` is the only property `POST /api/rag/query` accepts; any other property is rejected with
`INVALID_REQUEST`, deliberately, so a caller cannot influence retrieval.

### Configuration is validated at startup

The server checks every configuration it serves — Manufactum credentials, RAG retrieval,
database TLS, the RAG rate limit, and `PORT` — **once at startup**, and exits non-zero with a single
structured line naming every offending variable. A misconfigured release fails its deploy instead of
booting, reporting healthy, and failing on the first caller. No connection is opened and no model is
loaded by that check.

Required to start: `MANUFACTUM_API_BASE_URL`, `MANUFACTUM_API_KEY`, `MANUFACTUM_API_KEY_HEADER`,
`DATABASE_URL`. Everything else is optional with a documented default. `.env.example` is the complete
inventory; `docs/deployment-preflight.md` § 1 says which of them belong on a deployment.

### `/health` is not a readiness check

`GET /health` returns `{"status":"ok"}` from a handler that touches nothing. It does not prove the
database is reachable, that it holds active chunks, that the embedding model can load, or that TLS
works. **A real `POST /api/rag/query` returning `status: "found"` is the readiness signal.**

### Production build and start

```bash
npm run build                     # tsc → dist/
npm run rag:warm-embedding-cache  # pre-loads the pinned ~118 MB embedding artifact into the cache
npm run start                     # node dist/server.js
```

The warm-up is a build step, not a test: it opens no database connection, performs no ingestion, writes
no embedding, and exits non-zero if the pinned artifact cannot be loaded. Without it, the **first** RAG
query pays for the download. The embedding runtime is the memory-heavy part of this service — resident
set size measured locally went from 80 MiB idle to 924 MiB after the first RAG query — so size the host
accordingly; see `docs/deployment-preflight.md` § 2b.

### Checks and tests

```bash
npm run check        # typecheck + lint + format:check + tests + build
npm test             # vitest
npm run typecheck
```

The default test suite needs no database and no model: the PostgreSQL store and the embedding runtime
are stubbed. The destructive RAG PostgreSQL integration suite runs only when `RAG_TEST_DATABASE_URL`
points at a **disposable** database whose name ends with `_test`; it refuses to run against
`DATABASE_URL`. Never set `RAG_TEST_DATABASE_URL` on a deployment.

### Operator scripts

| Command                            | What it does                                                    |
| ---------------------------------- | --------------------------------------------------------------- |
| `npm run migrate`                  | Applies `migrations/` to `DATABASE_URL`.                        |
| `npm run rag:ingest`               | Ingests an approved FAQ page into a new staged version.         |
| `npm run rag:embed-staged`         | Embeds a staged version's chunks.                               |
| `npm run rag:warm-embedding-cache` | Build-time model cache warm-up. No database, no writes.         |
| `npm run rag:smoke-embedding`      | Asserts the embedding runtime's output properties. No database. |
| `npm run rag:smoke-retrieval`      | Read-only retrieval probes against `DATABASE_URL`.              |

### Documentation

`docs/api-contracts.md` (the contracts), `docs/deployment-preflight.md` (deployment inventory, memory
and cache notes, smoke tests), `docs/deployment-strategy.md` (stages and build commands),
`docs/project-decisions.md` (why things are the way they are).
