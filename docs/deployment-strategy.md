# Deployment Strategy

## Is deployment required immediately?

No.

Local API discovery can run from VS Code.

Deployment is required before Dialfire can reliably call the backend because Dialfire needs a public HTTPS endpoint.

## Stages

### Local

- API discovery;
- development;
- tests;
- local `.env`;
- no public access.

### Test

- public HTTPS;
- test credentials;
- Dialfire test agent;
- test database;
- redacted logs;
- scheduled RAG jobs.

### Production

- production secrets;
- production database;
- monitoring;
- backups;
- alerts;
- controlled releases.

## Hosting requirements

- Node.js;
- HTTPS;
- environment secrets;
- long-running web service;
- scheduled jobs or worker;
- PostgreSQL access;
- GitHub deployment;
- logs;
- health checks;
- rollback.

## Database timing

No database is required for Phase 1 API discovery.

PostgreSQL becomes useful for:

- store registry;
- reservations, if local state is needed;
- RAG documents;
- versions;
- chunks;
- embeddings;
- audit history.

## Deployment order

1. local `/health`;
2. local external API test;
3. one normalized endpoint;
4. test deployment;
5. verify `/health`;
6. verify product endpoint;
7. connect Dialfire;
8. add further features.
