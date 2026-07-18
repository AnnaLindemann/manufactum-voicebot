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

- one roadmap phase at a time;
- small commits;
- meaningful messages;
- no secrets;
- no undocumented schema changes.
