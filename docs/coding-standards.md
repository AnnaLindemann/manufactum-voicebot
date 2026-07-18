# Coding Standards

## Language

TypeScript with strict mode.

## Rules

- avoid `any`;
- validate all incoming input;
- validate all upstream responses;
- keep raw API types separate from internal models;
- keep secrets outside source code;
- use structured errors;
- keep route handlers thin;
- write tests for normalization and error handling.

## Layering

```text
route
→ controller
→ application service
→ integration client / repository
→ external dependency
```

## Error model

Every expected error includes:

- code;
- technical message;
- safe customer message;
- retryable flag;
- HTTP status.

## Logging

Log:

- correlation ID;
- endpoint;
- upstream status;
- latency;
- result count;
- error code.

Do not log:

- API keys;
- authentication headers;
- full personal data;
- unnecessary reservation payloads.

## Git

- Work on `main` during the MVP.
- Make one focused, meaningful commit after an accepted roadmap phase.
- Do not commit secrets, local `.env` files, or unredacted API responses.
- Run `npm run check` before a commit.
- Introduce branches, pull requests, and branch protection only when collaboration or release risk makes them necessary.

### Commit rules

- all MVP work happens directly on `main`; no phase branches are used;
- do not commit unless a commit is explicitly requested;
- commit only after the roadmap phase has been accepted;
- keep commits scoped to the active roadmap phase;
- describe the change, not the tool used to make it;
- run `npm run check` before a commit;
- never commit secrets, credentials, unredacted API samples, or personal data;
- documentation changes that support a phase belong in that phase's commit.
