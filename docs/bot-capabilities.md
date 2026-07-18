# Bot Capabilities

## Current status

Phase 2 — Internal API Contracts.

Phases 0 and 1 are accepted. The backend foundation is available locally, the upstream search API has
been observed and documented, and the MVP product-search contract is agreed. No customer-facing
voicebot capability is implemented yet, and no backend route calls the Manufactum API.

## Available now

- Local Node.js and TypeScript project.
- Express application.
- `GET /health` endpoint.
- Type checking, linting, formatting, and automated health test.
- A documented, evidence-based contract for the future `GET /api/products/search` route
  (`api-contracts.md`). Contract only — the route does not exist.

## Not available yet

- Manufactum API calls.
- Product search.
- Price or stock lookup.
- Store resolution.
- Online-shop availability.
- Alternatives.
- Reservation creation, lookup, or cancellation.
- Dialfire integration.
- Human transfer.
- Link delivery.
- RAG retrieval.
- Database or deployment.

## Planned capabilities

Capabilities are implemented only after the relevant roadmap phase is accepted.

Phase numbers below refer directly to `roadmap.md`. This document defines no numbering of its own.

| Roadmap phase | Capability unlocked                     |
| ------------- | --------------------------------------- |
| Phase 1       | External API discovery                  |
| Phase 2       | Internal API contracts                  |
| Phase 3       | Product search, price, and availability |
| Phase 4       | Store resolution                        |
| Phase 5       | Alternatives                            |
| Phase 6       | Reservations                            |
| Phase 7       | Public test deployment                  |
| Phase 8       | Dialfire integration                    |
| Phase 9       | Conversation design                     |
| Phase 10      | RAG source discovery                    |
| Phase 11      | RAG ingestion and versioning            |
| Phase 12      | RAG retrieval API                       |
| Phase 13      | RAG synchronization                     |
| Phase 14      | Link delivery                           |
| Phase 15      | End-to-end testing                      |
| Phase 16      | Production preparation                  |

Customer-facing demonstrations are grouped into milestones in `demo-roadmap.md`. Milestones combine
roadmap phases; they do not renumber them.

## Reliability rules

- Price, stock, availability, and reservation state must come from real-time APIs.
- The bot must not invent unsupported information.
- Reservation changes require explicit customer confirmation.
- Unsupported or unreliable requests must be transferred to a human when the integration exists.
