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
