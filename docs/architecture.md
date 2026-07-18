# Architecture

## High-level flow

```text
Caller
  ↓
Dialfire Voice Agent
  ↓ HTTPS
Custom Node.js Backend
  ├─ Product Integration
  ├─ Store Resolution
  ├─ Reservation Service
  ├─ Link Delivery
  ├─ RAG Retrieval
  └─ Logging and Audit
        ↓
Manufactum APIs

Manufactum Website / CMS
        ↓
RAG Ingestion Jobs
        ↓
PostgreSQL + pgvector
```

## Why a custom backend is necessary

Direct calls from Dialfire to every external system would create weak control over:

- credentials;
- raw response formats;
- business rules;
- reservations;
- error handling;
- testing;
- observability;
- RAG;
- future API changes.

The backend gives Dialfire one stable interface.

## Environment model

### Local

- API discovery;
- development;
- tests;
- no public access.

### Test

- public HTTPS;
- Dialfire integration;
- test credentials;
- test database;
- scheduled RAG jobs.

### Production

- production credentials;
- monitoring;
- backups;
- controlled releases.

## Security rules

- API keys only in environment secrets;
- no secrets in Git;
- no secrets in prompts;
- all public traffic over HTTPS;
- personal data minimized;
- reservation actions audited;
- sensitive payloads redacted;
- public endpoints rate-limited.

## Failure policy

The backend returns structured errors.

```json
{
  "code": "UPSTREAM_TIMEOUT",
  "safeCustomerMessage": "Ich kann den Bestand gerade nicht zuverlässig prüfen.",
  "retryable": true
}
```

Dialfire never reads raw technical errors to the caller.
