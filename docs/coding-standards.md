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

### Branch rules

`main` is the accepted-phase branch. It contains only phases that have been reviewed and accepted.

Direct commits to `main` are not allowed after the Phase 0 foundation commit.

All further phase work uses a dedicated branch:

```text
phase/<number>-<short-name>
```

Examples:

```text
phase/1-api-discovery
phase/2-internal-contracts
phase/3-product-search
```

Rules:

- one branch per roadmap phase;
- branch from current `main`;
- do not mix two roadmap phases in one branch;
- do not open a phase branch before the previous phase is accepted.

### Merge rules

A phase branch may be merged into `main` only after all of the following:

1. all checks pass (`npm run check`);
2. an implementation report exists for the phase;
3. an architecture and acceptance review has been performed;
4. review findings are resolved or explicitly accepted;
5. the phase is explicitly accepted;
6. merge approval is given explicitly.

Merging without explicit approval is not allowed, even when all checks pass.

### Commit rules

- do not commit unless a commit is explicitly requested;
- keep commits scoped to the active roadmap phase;
- describe the change, not the tool used to make it;
- never commit secrets, credentials, unredacted API samples, or personal data;
- documentation changes that support a phase belong in that phase's branch.
