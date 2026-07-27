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

### Added once RAG went live

The list above was written before `POST /api/rag/query` existed. The embedding runtime adds three
requirements that a platform must also satisfy:

- **a writable filesystem** for the pinned model cache (~130 MB observed locally). A read-only or
  purely in-memory filesystem cannot run this service;
- **native module support** — `@xenova/transformers` runs ONNX Runtime through `onnxruntime-node`,
  whose prebuilt binaries are selected per platform and architecture at install time. Build on the
  platform; do not upload a locally built `node_modules`;
- **enough memory for the loaded model.** Measured on the development machine, resident set size rose
  from 80 MiB idle to 924 MiB after the first RAG query, and stayed there. That is evidence from one
  16 GB Linux host and **not** a measurement of any platform's consumption, but it rules out the
  smallest instance tiers: provision at least 2 GB and treat 512 MB as untested. See
  `deployment-preflight.md` § 2b.

## Test-stage build and start

For Render, or any platform with the same three fields:

```text
Build command:  npm ci && npm run build && npm run rag:warm-embedding-cache
Start command:  npm run start
Health check:   /health
```

`PORT` is injected by the platform and must be left unset. The warm-up step loads the pinned embedding
artifact into the cache at build time and fails the build if it cannot; without it the first caller
pays for the download. The complete environment inventory, including which variables must **not** be
set on a deployment, is in `deployment-preflight.md` § 1.

`/health` proves liveness only. A release is proved ready by a real `POST /api/rag/query` returning
`found`, not by a green health check — see `deployment-preflight.md` § 2 and smoke test 10.

## Database transport

Every stage that reaches a database over a network must set `DATABASE_SSL_MODE` explicitly.
`verify-full` with `DATABASE_CA_CERT_PATH` pointing at the provider's PEM CA bundle is the target for
Test and Production; `require` encrypts without verifying and is a stopgap only. Unset means the driver
falls back to whatever `sslmode` the connection string carries — which, if it carries none, is
**plaintext**, including across the public internet. That is acceptable for a local loopback database
and for nothing else.

## Database timing

No database is required for Phase 1 API discovery.

**Since the RAG phases, a database is required for the Test stage**: `DATABASE_URL` is a mandatory
variable, checked at startup, and `POST /api/rag/query` reads a PostgreSQL + pgvector store. The
statement above remains correct for what it was about — the first API-discovery work — and is kept for
that reason.

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
7. verify the RAG endpoint returns recorded evidence;
8. connect Dialfire;
9. add further features.

Step 7 is not a formality: `/health` and the product endpoint can both pass on a release whose database
is empty, whose model never loaded, or whose TLS is misconfigured.
