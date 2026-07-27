# Test Deployment Preflight

Status: draft. Prepared after Phase 3 acceptance, before any deployment work, and revised twice since:
once by the deployment-readiness patch, and again by the deployment-hardening phase that followed the
read-only readiness audit. Sections written before `POST /api/rag/query` existed are corrected in
place and marked, rather than deleted — the original wording is the record of what was true when the
checkpoint was written.

Scope: what the **existing** backend needs in order to run behind a public HTTPS URL for a controlled
demo. It does not design Phase 4 or the Dialfire integration, and it changes no retrieval behaviour,
no embeddings, no chunks, and no thresholds. Everything below is derived from the current source, the
frozen documentation, and measurements recorded with their source.

Deployed surface today: `GET /health`, `GET /api/products/search`, and `POST /api/rag/query`.
Nothing else exists.

---

## 1. Environment variables

The complete inventory read by the running process. There are no others.

| Variable                         | Required              | Default         | Read where                             | Set on Render?                    | Notes                                                                                                                                                         |
| -------------------------------- | --------------------- | --------------- | -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | no                    | `3000`          | `src/config/port-config.ts`            | **No — Render injects it**        | Validated when present: an integer from 1 to 65535. `0`, a negative, a fractional, or a non-numeric value exits non-zero. Empty is treated as unset.          |
| `MANUFACTUM_API_BASE_URL`        | yes                   | —               | `src/config/manufactum-config.ts`      | yes                               | Must parse as a URL. Test-environment base URL.                                                                                                               |
| `MANUFACTUM_API_KEY`             | yes                   | —               | `src/config/manufactum-config.ts`      | yes, as a secret                  | **Secret.** Test credential only.                                                                                                                             |
| `MANUFACTUM_API_KEY_HEADER`      | yes                   | —               | `src/config/manufactum-config.ts`      | yes                               | Header name the key is sent under. Not itself secret, but paired.                                                                                             |
| `MANUFACTUM_API_TIMEOUT_MS`      | no                    | `8000`          | `src/config/manufactum-config.ts`      | optional                          | Set-but-malformed fails loudly; unset takes the default.                                                                                                      |
| `TRUST_PROXY`                    | no                    | off             | `src/server.ts`                        | **yes — `1`**                     | Express `trust proxy`. Render terminates TLS at its own proxy, so without this every caller shares one bucket and both limits become global. See `D-018`.     |
| `DATABASE_URL`                   | yes                   | —               | `src/config/rag-retrieval-config.ts`   | yes, as a secret                  | **Secret** (carries a password). PostgreSQL + pgvector, for `POST /api/rag/query`. Presence is checked at startup; no connection is opened there.             |
| `DATABASE_SSL_MODE`              | no (but see §1a)      | driver default  | `src/config/database-ssl.ts`           | **yes — `verify-full`**           | `disable`, `require`, or `verify-full`. Unset passes no `ssl` option, leaving the connection string's own `sslmode` to govern. An unknown value fails loudly. |
| `DATABASE_CA_CERT_PATH`          | when `verify-full`    | —               | `src/config/database-ssl.ts`           | **yes — Render Secret File path** | Path to the provider's PEM CA bundle. Read once at startup; missing, unreadable, or non-PEM fails the deploy. Contents are never logged.                      |
| `RAG_RETRIEVAL_MIN_SCORE`        | no                    | `0.8`           | `src/config/rag-retrieval-config.ts`   | no                                | Minimum cosine similarity. Set-but-malformed or outside `0..1` fails loudly; unset takes the provisional default.                                             |
| `RAG_EMBEDDING_LOCAL_FILES_ONLY` | no                    | off             | `src/config/rag-retrieval-config.ts`   | **not initially** — see §2b       | `true` forces the embedding runtime to use only cached model files. Only after a warmed runtime cache is verified.                                            |
| `TRANSFORMERS_CACHE`             | no                    | library default | `src/config/rag-retrieval-config.ts`   | recommended — see §2b             | Where the pinned embedding artifact is cached. The build-time warm-up and the running server must agree on it.                                                |
| `RAG_RATE_LIMIT_MAX_REQUESTS`    | no                    | `10`            | `src/config/rag-rate-limit-config.ts`  | optional                          | Bounded 1–60. `0`, negative, fractional, or out-of-range fails the deploy. There is no value that switches the limiter off.                                   |
| `RAG_RATE_LIMIT_WINDOW_MS`       | no                    | `60000`         | `src/config/rag-rate-limit-config.ts`  | optional                          | Bounded 1000–600000.                                                                                                                                          |
| `RAG_TEST_DATABASE_URL`          | local test suite only | —               | `tests/helpers/disposable-database.ts` | **NEVER**                         | See the explicit exclusion below.                                                                                                                             |

`NODE_ENV` is not read anywhere in the codebase. Setting it changes nothing today except Express's
own internals; it is not a configuration switch for this backend.

### `RAG_TEST_DATABASE_URL` must never be set on Render

It exists for one purpose: to point the **destructive** RAG PostgreSQL integration suite at a
disposable database. That suite `TRUNCATE`s RAG tables. The guard in
`tests/helpers/disposable-database.ts` refuses to run unless the connected database name ends with
`_test` and does not resolve to the same database as `DATABASE_URL`, so it cannot destroy the working
data — but the correct place to stop this is one step earlier: **the variable has no meaning on a
deployment and must not exist there.** Nothing in the running server reads it. If it is present in a
Render environment, remove it; do not "point it somewhere safe".

### 1a. Why `DATABASE_SSL_MODE` is effectively required on Render

The connection string alone does not say how the connection is protected. `pg` decides that from
whatever `sslmode` the string happens to carry, and if it carries none, the connection is **plaintext**
— including to a managed database reached across the public internet, where every handshake sends the
database password. A retrieval query returns published FAQ text and carries no secret, but the
credential on the wire is real.

Unset therefore stays the default only because it is the right behaviour for a local Postgres on a
loopback socket. Any deployment must set it explicitly:

- `verify-full` + `DATABASE_CA_CERT_PATH` — encrypted **and** the server's certificate verified. This
  is the target state for Render + Supabase.
- `require` — encrypted, certificate **not** verified. Stops passive eavesdropping, not an active man
  in the middle. A stopgap while the CA file is being obtained, never the end state.
- `disable` — plaintext, chosen deliberately and visibly.

`prefer` and `allow` are not accepted: both mean "encrypt if it happens to work", which is the silent
downgrade this setting exists to prevent.

No CA certificate is committed to this repository. Download the provider's bundle (Supabase: Project
Settings → Database → SSL Configuration), add it as a **Render Secret File**, and point
`DATABASE_CA_CERT_PATH` at the mount path Render reports (typically `/etc/secrets/<filename>`).

### Secret handling

- `.env` is git-ignored (`.gitignore`), `.env.example` is committed and holds no values. That is the
  Phase 0 rule and it still holds — nothing in this checkpoint changes it.
- Secrets are set in the platform's own secret store, never in a committed file, never in a
  Dockerfile, never in a build argument, never in the repository.
- The test deployment uses **test credentials only**, separate from production
  (`deployment-strategy.md` § Stages, `architecture.md` § Environment model).
- The logger cannot leak the key: `src/logging/logger.ts` accepts a closed field set that contains
  neither the key, the header value, nor upstream bodies. Config errors name the offending variable
  and never its value. No change needed here — only don't add ad-hoc `console.log` during demo
  debugging.

### Preflight risk: credentials are validated lazily

`loadManufactumConfig()` runs inside the request path
(`src/integrations/manufactum/product-search-client.ts:71`), not at startup. Consequences for a
deployment:

- a deploy with missing or malformed Manufactum variables **still boots and still returns `200` on
  `/health`** — the platform reports the release healthy;
- the failure only surfaces on the first real search, as `INTERNAL_ERROR` / HTTP `500`.

This is intentional (it keeps tests and health checks credential-free), but it means **`/health`
alone must never be treated as proof that a release is configured correctly.** Smoke test 3 below
exists specifically to close this gap. Whether to add a startup-time configuration check is a
decision for §6, not something to change here.

**Resolved by the deployment-readiness patch.** `src/server.ts` now validates the configuration once
at startup and exits non-zero on a missing or malformed variable, so a misconfigured release fails
the deploy instead of reporting healthy. The lazy read in the request path is unchanged. `/health`
still proves only liveness, so smoke test 3 remains the check that upstream credentials work.

**Extended with `POST /api/rag/query`.** The same startup check now covers the RAG retrieval
configuration, for the same reason: the route is registered from process start, so a release without
`DATABASE_URL` or with a malformed `RAG_RETRIEVAL_MIN_SCORE` would boot, report healthy, and answer
every retrieval call with `INTERNAL_ERROR`. Both configurations are evaluated even when one fails, so
one deploy reports every offending variable.

The check covers **presence and shape only**. It opens no connection, runs no query, and does not
load the embedding model. Two consequences to plan a deployment around:

- a correct `DATABASE_URL` pointing at an unreachable, unmigrated, or empty database still starts
  cleanly and fails at request time as `INTERNAL_ERROR` / HTTP `500`. Startup validation is not a
  substitute for a retrieval smoke test after deploy;
- the pinned embedding artifact (~118 MB) is fetched or read on the **first** query, not at boot, so
  the first RAG call after a release is materially slower than the rest. Either pre-warm it or expect
  it. `TRANSFORMERS_CACHE` must point somewhere writable and, ideally, persistent — on an ephemeral
  filesystem the download repeats on every restart.

---

## 2. Health and production start

### Render commands

```text
Build command:  npm ci && npm run build && npm run rag:warm-embedding-cache
Start command:  npm run start
Health check:   /health
```

- Start command: `npm run start` → `node dist/server.js`. It requires `npm run build` to have run;
  `dist/` is git-ignored, so the platform must build, not just install.
- Use `npm ci` — `package-lock.json` is committed.
- `devDependencies` are needed at build time (`typescript`, `tsx`), so a build step that installs
  production dependencies only will fail. Install everything, build, then let the platform prune if it
  wants — but see §2b: a prune that removes `node_modules/@xenova/transformers/.cache` also removes the
  warmed model unless `TRANSFORMERS_CACHE` points outside the dependency tree.
- `npm run rag:warm-embedding-cache` is the third build step and is **not optional** for a usable
  deployment; §2b explains what it does and why the build is the right place for it.
- `src/server.ts` binds with `app.listen(port)`, i.e. all interfaces. No change needed for a
  container.
- Health check path: `GET /health`, expect `200` and `{"status":"ok"}` (`src/app.ts`). Configure
  exactly this path in Render's health-check field.

### `/health` proves liveness, not RAG readiness

This distinction has already caused one wrong conclusion in this document's history, so it is stated
plainly. `GET /health` returns `{"status":"ok"}` from a handler that reads nothing, calls nothing, and
knows nothing about retrieval. A `200` from it means: the process is alive, Express is routing, and the
port is bound.

It does **not** mean any of the following:

| `/health` says `200`, but…              | Why it can still be broken                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the database may be unreachable         | Startup validates that `DATABASE_URL` is present and well-shaped. It opens **no connection**.                                                                     |
| the database may be empty or unmigrated | No query runs at startup. An empty `rag_chunks` answers every question with `not_found`, which looks like a working endpoint with nothing to say.                 |
| the embedding model may not be loaded   | The ~118 MB artifact loads on the **first query**, not at boot. If the cache is cold and the network is unavailable, the first query fails, not the health check. |
| TLS may be misconfigured at the socket  | An unreadable CA fails startup, but a certificate that is readable and simply wrong fails at the first handshake — inside a request.                              |
| upstream credentials may be wrong       | `loadManufactumConfig` is validated at startup for shape only; no upstream call is made until a real search.                                                      |

**RAG readiness is proved only by smoke test 10** below — a real `POST /api/rag/query` returning
`found` with a `chunkKey`. Treat that, not `/health`, as the deployment's acceptance signal. Adding a
deeper readiness endpoint is deliberately not done here: a health check that queries the database and
loads a 118 MB model would make the platform's probe the most expensive request the service serves,
and a slow database would restart a healthy process.

- `"type": "module"`, `target: es2022`, `module: nodenext`. Verified locally on Node v24.11.0.
- **Node version is pinned**: `engines.node` is `^24.11.0` in `package.json`, i.e. Node 24 at or above
  the locally verified 24.11.0, and below 25. This covers Render's current 24.14.1 runtime without
  requiring the platform and the developer machine to run byte-identical versions. `engines.node` is
  the single pin; no `.nvmrc` or `.node-version` file is used, so there is only one place to change.
- The pin is **advisory to npm** by default: `npm install` warns on a mismatched Node rather than
  failing, unless `engine-strict` is enabled. It is authoritative for the platform, which reads
  `engines.node` to select the runtime. That asymmetry is accepted here — the pin exists to make the
  deployed runtime reproducible, not to police local machines.
- No graceful `SIGTERM` shutdown exists. Acceptable for a controlled demo (in-flight requests may be
  cut on redeploy); it should not carry into production, where `deployment-strategy.md` requires
  controlled releases and rollback.
- Logs go to stdout/stderr as one JSON line per event. Any platform that captures stdout satisfies
  the "logs" hosting requirement without extra work.

---

## 2b. Memory, native dependencies, and the model cache

### Memory: measured locally, not on Render

**This is evidence from the development machine. It is not a measurement of Render, and it is not
proof of what Render will consume.** V8 sizes its heap against the host's available RAM, and this host
has 16 GB; a container with a smaller limit will behave differently. What the numbers do establish is
the **shape** of the memory profile — a small idle process and a large, permanent step when the
embedding runtime loads — and that the step is far too large for the smallest instance tiers.

Measured on 2026-07-27, Linux (WSL2), Node v24.11.0, 16 GB host, against the **compiled** server
(`node dist/server.js`), with a real read-only retrieval query against the working database:

| Point in the process lifetime         | Resident set size |
| ------------------------------------- | ----------------- |
| Started, before any RAG query         | **80 MiB**        |
| After the first `POST /api/rag/query` | **924 MiB**       |
| After the second query                | 924 MiB           |

The step is ~844 MiB and it is not transient: the loaded ONNX session and its weights stay resident for
the process lifetime. Re-running the warm-up under a deliberately constrained V8 heap
(`--max-old-space-size=384`) still peaked at ~837 MiB RSS while producing a correct embedding, which
says most of the footprint is outside the JavaScript heap and cannot be tuned away with a flag.

Latency from the same run: first query **2156 ms** (model load included), second query **81 ms**.

**Practical conclusion, stated as a risk rather than a certainty:** a 512 MB instance is very unlikely
to survive the first RAG query, and the failure mode would be an OOM kill of the whole web service —
not a `500`, but a restart, on the first question anyone asks. Provision an instance with **at least
2 GB** and treat anything smaller as untested. Anna must confirm the actual figure from Render's own
metrics after the first successful RAG query; that observation replaces this estimate.

### Native dependencies

The earlier statement in §4 that the app has "no filesystem state and no native dependencies" was
written before RAG existed and is now wrong on both counts.

- `@xenova/transformers` runs ONNX Runtime through `onnxruntime-node`, which ships **prebuilt native
  binaries** and selects them per platform and architecture at install time. A build performed on one
  architecture and run on another will not work; Render's standard Linux x64 runtime matches the
  binaries npm installs there, so building **on** Render (rather than uploading a locally built
  `node_modules`) is what keeps this correct.
- `pg` is pure JavaScript here — `pg-native` is not installed — so the database driver adds no native
  requirement.
- The process therefore needs a **writable filesystem** for the model cache, and enough disk for a
  ~118 MB artifact plus the tokenizer files (~130 MB total observed locally).

### The model cache and the warm-up step

The pinned artifact is fetched or read on the **first query**. Without a warm-up, the first caller pays
a multi-second download on a cold instance, and if the network is unavailable the endpoint fails
outright. `npm run rag:warm-embedding-cache` moves that cost into the build:

- it loads the pinned profile and runs **one** throwaway inference to prove the artifact actually
  executes, not merely that it downloaded;
- it opens **no** database connection, performs **no** ingestion, and writes **no** embedding to
  storage — it needs no `DATABASE_URL` and cannot damage RAG data;
- it exits **non-zero** when the artifact cannot be loaded, so a broken release fails its build instead
  of shipping;
- it honours `TRANSFORMERS_CACHE`.

Measured on the development machine on 2026-07-27, again as **local evidence and not a Render
measurement**: a cold warm-up into an empty `TRANSFORMERS_CACHE` took **69.3 seconds** and wrote
**130 MB**; the same command against that warmed cache, with `RAG_EMBEDDING_LOCAL_FILES_ONLY=true`,
loaded in **1.5 seconds**. The 69 seconds is what the **first caller** pays if the build step is
skipped — long enough to time out a voice call, a Dialfire tool call, and most patience.

It is deliberately separate from `npm run rag:smoke-embedding`, which is a _test_ asserting seven
properties of the runtime's output. Merging them would produce either a build that fails on an
assertion unrelated to caching, or a test whose result depends on cache state.

**`TRANSFORMERS_CACHE` must be the same value at build time and at run time.** Unset, the library
caches into `node_modules/@xenova/transformers/.cache` (observed locally: 130 MB). That works only if
`node_modules` survives from build to runtime unchanged; a dependency prune between the two would
delete the warmed cache and silently return the first-query download. Setting an explicit path inside
the project directory avoids the question entirely.

**Do not set `RAG_EMBEDDING_LOCAL_FILES_ONLY=true` yet.** It forbids any download, which turns a cache
miss from a slow first query into a failed one, and the warm-up itself cannot populate a cache while it
is set. Enable it only **after** a deployed instance has been observed serving a `found` RAG response
with a warm cache — at which point it becomes a useful guard against an unnoticed re-download. Until
then it converts a latency problem into an outage.

---

## 3. Public endpoint security

Once the URL is public, `/api/products/search` **and `/api/rag/query`** are reachable by anyone who
finds them. This section was originally written when only the search route existed; the RAG route is
now equally exposed and is covered here. What is already in place, and what is not:

**Already handled by the code** — no work needed:

- input is validated before any upstream call (`INVALID_REQUEST`, no upstream call made);
- `limit` is capped at 5 and `q` at 200 characters, so a single request cannot be inflated;
- upstream status codes and bodies are never forwarded; errors leave as the fixed envelope;
- the API key never appears in a response, an error, or a log line;
- caller-spoken query text is deliberately not logged.

**Real risks that remain:**

| Risk                            | Why it matters here                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No authentication               | Both routes are fully open. Anyone with the URL can query them. **Accepted deliberately** — a shared token was rejected because Dialfire secret storage is unconfirmed (`D-018`). The rate limits are the compensating control.                        |
| ~~No rate limiting~~            | **Closed for both routes.** 20 requests per minute per client IP on search; 10 per minute on `/api/rag/query`, separately configured; `/health` exempt from both. A rejected request makes no upstream call, runs no embedding, and reads no database. |
| Upstream cost amplification     | Bounded, not eliminated: the limit caps how fast one client can spend our upstream credential. It is per process and in memory, so the deployment must run a **single instance**.                                                                      |
| ~~Unbounded CPU on RAG~~        | **Bounded.** Embedding inference is the heaviest work this process does; the RAG limiter caps how often an anonymous caller can trigger it. Concurrency within the limit is still unbounded — see the memory note in §2b.                              |
| ~~Idle pool error is fatal~~    | **Closed.** An idle-client failure in the pg pool used to be an unhandled `error` event, i.e. process death with no request involved. It is now one redacted log line; the pool discards the client and continues.                                     |
| ~~Database transport unstated~~ | **Configurable and validated.** `DATABASE_SSL_MODE` must be set explicitly on a deployment; `verify-full` fails the deploy without a readable CA. See §1a — the current working connection string carries no `sslmode`.                                |
| No total request budget         | `MANUFACTUM_API_TIMEOUT_MS` bounds the upstream call only. Total handling time is measured but unlimited (Phase 3 unresolved question 4). This now also covers the RAG path, whose first query is measurably slow (§2b).                               |
| Discoverable URL                | Platform-assigned hostnames are guessable and appear in TLS certificate-transparency logs. Treat the URL as public knowledge, not as a secret.                                                                                                         |

`architecture.md` § Security rules states plainly: **"public endpoints rate-limited"**. That rule is
now satisfied: option 2 below was chosen and implemented, without a new dependency. Option 1 was
considered and rejected (`D-018`).

**Minimum safeguards for a controlled demo:**

1. ~~A shared static token on `/api/products/search`.~~ **Rejected.** Dialfire's secret storage is
   unconfirmed, so a token living in its script would not be secure, and an insecure token gives the
   appearance of access control without the substance.
2. **Rate limiting per IP. Implemented** — 20 requests per minute, `/health` exempt, no new
   dependency.
3. Keep the deployment up only for the duration of the demo, and take it down afterwards. **Still
   required**, and it carries more weight now that there is no inbound authentication at all.
4. HTTPS only, with plain HTTP redirected — every platform in §4 does this by default.
5. Test credentials only, with a quota or spend limit on the upstream key if the client can set one.
   **Still recommended**: the limiter caps the rate, not the total.

Items 3, 4, and 5 are operational, not code, and remain open at deploy time.

---

## 4. Compatible platforms

Requirements to satisfy, from `deployment-strategy.md` § Hosting requirements: Node.js, HTTPS,
environment secrets, a long-running web service, GitHub deployment, logs, health checks, rollback.

> **Corrected.** This section originally read "no database is required for this checkpoint and none
> should be provisioned now (`D-003`)". That was true when only `GET /api/products/search` existed. It
> is now false: `POST /api/rag/query` is implemented and live, `DATABASE_URL` is a **required**
> variable checked at startup, and the deployment reads a PostgreSQL + pgvector database. `D-003` said
> no database was needed _during the first API tests_, which is a different and still-correct claim.

> **Corrected.** This section also described the app as "a plain stateless Node HTTP server reading
> `PORT`, with no filesystem state and no native dependencies". Two of those three are now wrong: the
> embedding runtime brings a **native** ONNX dependency and needs a **writable filesystem** for a
> ~130 MB model cache. See §2b. The consequence for platform choice is real — a runtime that is not
> Node, or that offers no writable filesystem, is no longer merely inconvenient but incompatible.

Candidates that meet every requirement above without code changes:

- **Render** — GitHub auto-deploy, managed TLS, secret store, health-check path, one-click rollback,
  Node build/start commands. Closest fit to the requirement list with the least configuration.
- **Railway** — equivalent feature set, similar effort.
- **Fly.io** — more control, needs a Dockerfile, so slightly more work now for portability later.
- Any container host (Cloud Run, App Runner, Azure Container Apps) — all workable; scale-to-zero
  ones reintroduce the cold-start question in Phase 3's unresolved question 1.

Not compatible without changes: static hosts, and edge/serverless runtimes that are not Node
(Cloudflare Workers, Deno Deploy). Vercel/Netlify would need the app restructured into their
function model, which would mean redesigning the backend — explicitly out of scope.

No recommendation is committed here; the platform choice is a §6 decision.

---

## 5. Smoke tests

Run against the deployed base URL. `$BASE` is the public HTTPS origin, `$KEY` the demo token if
safeguard 1 is adopted. These verify the deployment, not the contract — the contract is already
covered by the test suite.

**1. Health**

```bash
curl -i "$BASE/health"
```

Expect: `200`, body exactly `{"status":"ok"}`, and a `x-correlation-id` response header.
Proves only that the process is up and routing works. It does **not** prove configuration is valid.

**2. Unknown route returns the envelope, not Express HTML**

```bash
curl -i "$BASE/api/does-not-exist"
```

Expect: `404`, JSON body with `code: "NOT_FOUND"`, a `safeCustomerMessage`, `retryable: false`, and a
`correlationId`. Confirms the `D-012` handlers survived the build — a deployment that returns
Express's HTML default here is misbuilt.

**3. Real search — the test that actually proves the deployment is configured**

```bash
curl -i "$BASE/api/products/search?q=Seife"
```

Expect: `200`, and a body with `query`, `resultCount`, `storeResolution: { "status":
"not_requested" }`, and a `products` array. Each product carries `sku`, `name`, `priceText`, `description`, `highlights`,
`productUrl`, `availability`. `priceText` must be the verbatim localized string (e.g. `"11,90 €"`),
never a parsed number.

- A `500` / `INTERNAL_ERROR` here means the Manufactum environment variables are missing or malformed
  — the lazy-validation case from §1.
- A `502` / `UPSTREAM_AUTH_FAILED` means the key or its header name is wrong for this environment.
- A `504` / `UPSTREAM_TIMEOUT` means the deployed environment is slower than the dev environment the
  8-second timeout was calibrated against. Record the number; it answers Phase 3's unresolved
  question 1.

**4. Validation rejects before any upstream call**

```bash
curl -i "$BASE/api/products/search"
curl -i "$BASE/api/products/search?q=Seife&limit=9"
curl -i "$BASE/api/products/search?q=Seife&limit=abc"
curl -i "$BASE/api/products/search?q=Seife&store=Berlin&storeId=MANUFACTUM_BERLIN_KGA"
curl -i "$BASE/api/products/search?q=Seife&storeId=MANUFACTUM_BERLIN_KGA&warehouseId=MANUFACTUM_BERLIN_KGA"
```

Expect all five: `400` with `code: "INVALID_REQUEST"`, `retryable: false`. No upstream call should
appear in the logs for any of them. The last two are the mutually-exclusive store selectors —
including `storeId` with its own deprecated alias carrying the _same_ value, which is still rejected.

**5. No results is a normal `200`, not an error**

```bash
curl -i "$BASE/api/products/search?q=zzzzzzzzzz"
```

Expect: `200`, `resultCount: 0`, `products: []`, and **no** error envelope. A `404` here would
contradict `api-contracts.md`.

**6. Store selection reports what it actually resolved**

```bash
curl -i "$BASE/api/products/search?q=Seife&storeId=MANUFACTUM_BERLIN_HAUS_HADENBERG"
curl -i "$BASE/api/products/search?q=Seife&store=Berlin"
curl -i "$BASE/api/products/search?q=Seife&store=Hamburg"
```

Expect all three: `200`.

- The first: `storeResolution.status: "matched"` with `selectedStore`, and every product's
  `availability` containing that one store or an empty array.
- The second: `storeResolution.status: "ambiguous"` with a `candidates` array, if the live response
  carries more than one Berlin branch, and `availability` left unfiltered. If the environment has
  only one Berlin branch, `matched` is correct here instead.
- The third: `storeResolution.status: "not_found"`, `availability` left unfiltered, and **no**
  `selectedStore`.

An unfiltered `availability` under `ambiguous` or `not_found` is the contracted behavior, not a bug:
no store was selected, so that list is every store's availability and must not be presented as the
requested store's stock. Confirm too that `availability: []` is never rendered anywhere as an
out-of-stock claim.

**6b. The deprecated `warehouseId` alias still works**

```bash
curl -i "$BASE/api/products/search?q=Seife&warehouseId=MANUFACTUM_BERLIN_HAUS_HADENBERG"
```

Expect: a body **identical** to step 6's first command. `warehouseId` is a deprecated compatibility
alias for `storeId` and takes the same local resolution path; new clients should send `storeId`. Note
that it no longer causes a `warehouse` parameter to be sent upstream — check the logs to confirm the
outbound call carries only `q` and `limit`.

**7. Correlation ID round-trip**

```bash
curl -i -H "x-correlation-id: preflight-001" "$BASE/api/products/search?q=Seife"
```

Expect: `preflight-001` echoed in the response header, and the deployed logs show a
`request_completed` line carrying it with `requestLatencyMs` and `upstreamLatencyMs`. Confirms
traceability works through the platform's log capture — the thing that makes a demo failure
diagnosable afterwards.

**8. Rate limit is active**

```bash
for i in $(seq 1 21); do
  printf '%s ' "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/products/search?q=Seife")"
done
```

Expect: twenty `200`s followed by `429`. Then confirm the envelope and the wait hint:

```bash
curl -i "$BASE/api/products/search?q=Seife"
```

Expect: `429`, `code: "RATE_LIMITED"`, `retryable: true`, a `correlationId`, and a `Retry-After`
header in whole seconds. After that many seconds, a further request returns `200` again.

Confirm too that `/health` still answers `200` while the search route is rejecting — a platform probe
must never be limited into a false unhealthy state.

If the first request already returns `429`, or the limit appears to be shared across machines, the
deployment is running more than one instance and the in-memory counter is per process. Reduce it to a
single instance.

**9. Secret leak check**

Read the deployed logs from the runs above. Confirm no line contains the API key, the value of the
API-key header, an upstream response body, or the `q` value.

---

## 5b. RAG smoke tests

`POST /api/rag/query` is live and public, and none of the tests above touch it. These are the tests
that prove the RAG half of the deployment works. Run them in order: 10 is the one that proves the
deployment is genuinely ready, and 11–14 characterise what it will and will not answer.

The request body field is **`query`**, and it is the only property accepted. `question` is not a field
name in this contract.

**10. RAG readiness — the test that replaces `/health` as the acceptance signal**

```bash
curl -i -X POST "$BASE/api/rag/query" \
  -H "content-type: application/json" \
  -d '{"query":"Welche Vorteile bietet mir ein Konto?"}'
```

Expect: `200`, `status: "found"`, and an `evidence` array whose **first** item is
`chunkKey: "mein-konto:v1:chunk-002"` with `source.documentKey: "mein-konto"`,
`source.documentVersion: 1`, and `source.sourceUrl: "https://www.manufactum.de/konto-c201130/"`.
The full expected body is in `api-contracts.md` § Response — found; it was captured from a real run
against this data.

Locally this returns three items, scoring `0.930097`, `0.831382`, and `0.828603`. The deployed scores
should match to six decimals: the embedding profile is pinned to an immutable revision and the ranking
is deterministic. **A difference here is a real signal**, not noise — it means a different artifact, a
different revision, or different chunks.

- A `500` / `INTERNAL_ERROR` means the database is unreachable, unmigrated, TLS failed at the socket,
  or the embedding model could not be loaded. Check the deployed logs for
  `rag_query_completed` (absent) and for `startup_configuration_invalid` (should also be absent, since
  the process started).
- `status: "not_found"` on this query means the database is reachable but the **active chunks are
  missing** — an empty or unmigrated database answers every question this way. This is the failure that
  most resembles success, which is why the expected `chunkKey` is named above.
- Note the first-query latency (§2b measured 2156 ms locally). If it is seconds slower than the second
  call, the build-time warm-up did not survive into the runtime filesystem — revisit
  `TRANSFORMERS_CACHE` in §2b.

**11. The same query twice, for the model-load boundary**

```bash
time curl -s -o /dev/null -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"Wie kann ich mich bei Manufactum registrieren?"}'
time curl -s -o /dev/null -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"Wie kann ich mich bei Manufactum registrieren?"}'
```

Expect: both `200`; the second materially faster than the first if the first call in step 10 was the
one that loaded the model. Record both numbers — they are the deployed equivalent of the local 2156 ms
/ 81 ms and the input to any later decision about `RAG_EMBEDDING_LOCAL_FILES_ONLY`.

**12. A question outside the knowledge base is `not_found`, not an error and not an invention**

```bash
curl -i -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"Wie repariere ich eine Kaffeemühle?"}'
```

Expect: `200`, `status: "not_found"`, `evidence: []`. **Not** a `404`, and **not** a low-confidence
match presented as an answer. This is the contracted behaviour: the knowledge base currently holds the
_Mein Konto_ FAQ only, and everything else is correctly out of scope.

**13. Validation rejects before any embedding or database read**

```bash
curl -i -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{}'
curl -i -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"   "}'
curl -i -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"Frage?","minScore":0,"maxChunks":50}'
curl -i -X POST "$BASE/api/rag/query" -H "content-type: application/json" -d '{"query":"Frage?"'
curl -i "$BASE/api/rag/query"
```

Expect: the first four `400` with `code: "INVALID_REQUEST"`, `retryable: false`; the last `404` with
`code: "NOT_FOUND"` (a `GET` on the path). The third is the important one: a caller attempting to widen
retrieval is **rejected**, not quietly ignored. Confirm in the logs that no `rag_query_completed` line
appears for any of them.

**14. The RAG rate limit is active and separate from the search limit**

```bash
for i in $(seq 1 11); do
  printf '%s ' "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rag/query" \
    -H "content-type: application/json" -d '{"query":"Frage zum Konto?"}')"
done
```

Expect: ten `200`s followed by `429`, with `code: "RATE_LIMITED"`, `retryable: true`, a
`correlationId`, and a `Retry-After` header in whole seconds. Then confirm the two limits are
independent:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/products/search?q=Seife"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"
```

Expect: `200` for both while RAG is still rejecting. A `429` on the search route here would mean the
two limiters are sharing state, which they must not.

If the very first RAG request already returns `429`, or the limit appears shared across machines, the
deployment is running more than one instance — reduce it to one (§3).

**15. RAG secret and content leak check**

Read the deployed logs from steps 10–14. Confirm that:

- the caller's **question text never appears** — it is caller-spoken text and is deliberately not
  logged; only `rag_query_completed` with a correlation ID, the endpoint, and `resultCount`;
- no line contains `DATABASE_URL`, a password, a host name from the connection string, SQL, or a
  filesystem path;
- if the database restarted during the session, any `rag_pool_idle_client_error` line carries only the
  fixed message and at most a code such as `57P01` or `ECONNRESET` — and the **service did not
  restart**, which is the whole point of that listener.

### Known accepted limitation to expect during the demo — "Liste für später"

`rag-canonical-question-top3-reranking-experiment-report.md` records query 067, the short ambiguous
phrase **"Liste für später"**, as an unresolved case with a deteriorated margin: the phrase is generic
and does not carry enough signal to separate the Merkliste FAQ items from their neighbours. It is a
**known, accepted limitation**, not a regression and not a deployment fault.

If a demo question of that shape returns the wrong Merkliste item, or returns `found` with evidence
that does not answer it, the correct response is to note it and move on — not to retune the threshold,
the chunks, or the reranking during a deployment. Retrieval behaviour is frozen for this checkpoint.
More generally, and for the same reason: at `0.80` the measured behaviour on the labelled set accepts
most unanswerable questions rather than rejecting them, so a `found` response means something matched,
never that it answers the caller. Step 10's own output demonstrates this — its second and third
evidence items are about registration and passwords, not about account benefits.

---

## 6. Contradictions and decisions required

Status after the deployment-readiness patch: **C-1, C-2, and C-6 are resolved** by `D-018` and the
code it records. **C-3 is resolved** by the reproducibility update that followed. C-4 and C-5 remain
open. The original wording is kept below as the record of what the checkpoint found.

The deployment-hardening phase adds **C-7 through C-11**, all closed in code, and leaves C-4 and C-5
untouched.

**C-7. An idle pool error killed the process.** — **Closed.** `pg.Pool` emits `error` for a client
that fails while idle in the pool, and an unhandled `error` event terminates Node. A managed database
restarting overnight would therefore take the web service down with no request in flight and no
explanation in the logs. A listener now turns it into one redacted structured line; the pool discards
the client and the next query reconnects. Request-level handling is unchanged.

**C-8. The database transport was whatever the connection string happened to say.** — **Closed.**
`DATABASE_SSL_MODE` and `DATABASE_CA_CERT_PATH` make it explicit and validated, and `verify-full` fails
the deploy without a readable CA bundle. Note the finding that prompted it: the working `DATABASE_URL`
points at a Supabase pooler over the public internet and carries **no** `sslmode`. See §1a.

**C-9. `POST /api/rag/query` was public and unlimited.** — **Closed.** Its own limiter, 10 requests per
minute per client IP, separately configured within a bounded range. `api-contracts.md` had recorded the
condition under which the "not rate-limited" decision must be revisited; this deployment is that
condition.

**C-10. The embedding artifact loaded on the first caller's request.** — **Closed for the build.**
`npm run rag:warm-embedding-cache` is a build step that loads the pinned artifact, proves it runs, and
fails the build otherwise. Whether the warmed cache actually survives into Render's runtime filesystem
is a **manual check** — see §2b and smoke test 11.

**C-11. `PORT` was unvalidated.** — **Closed.** `PORT=` (empty), `PORT=0`, and any non-numeric value
used to mean "bind an OS-assigned ephemeral port", producing a live process that reported healthy and
was unreachable. It is now validated as an integer from 1 to 65535, and an invalid value exits
non-zero. It must remain **unset** on Render, which injects its own.

**C-1. Rate limiting is required by frozen documentation and does not exist.** — **Resolved.**
`GET /api/products/search` is limited to 20 requests per minute per client IP, and `RATE_LIMITED`
(HTTP `429`, retryable) is in the contract. A shared inbound token was rejected; see `D-018`.
`architecture.md` § Security rules requires public endpoints to be rate-limited. The code has no rate
limiting, and Phase 3 correctly did not add it — the roadmap places it in Phase 16. Deploying
publicly now therefore contradicts `architecture.md`. Decision needed: accept the gap explicitly for
a supervised demo (with a compensating safeguard from §3 and a recorded deferral), or implement a
minimum limiter before going public. This must be settled before the URL exists, not after.

**C-2. Phase ordering: the roadmap and the deployment strategy disagree.** — **Resolved.** The Test
Deployment is a separate checkpoint after accepted Phase 3; Phase 4 remains the next roadmap phase.
See `D-018`.
`roadmap.md` places Public Test Deployment at **Phase 7**, after store resolution, alternatives, and
reservations. `deployment-strategy.md` § Deployment order places test deployment at step 4,
immediately after one normalized endpoint — which is exactly where the project stands now, and which
`D-008` ("deploy only after one local endpoint works") supports. Both readings are defensible; they
cannot both be followed. Decision needed: is this checkpoint an early, deliberate pull-forward of
Phase 7 for demo purposes, or a separate milestone? Either way it should be recorded as a decision,
because the Phase 3 report's own recommendation names Phase 4 as next.

**C-3. No `engines` field.** — **Resolved.** `engines.node` is `^24.11.0`: at or above the locally
verified 24.11.0, below 25, and satisfied by Render's current 24.14.1. A deployed release can no
longer silently run a different major than the one the project was verified on. A range rather than
an exact version, because local and platform runtimes differ in patch level and an exact pin would
have to be wrong for one of them. See §2.

**C-4. The 8-second upstream timeout is calibrated against dev only.**
Phase 3 unresolved question 1, unchanged. Smoke test 3 is the measurement that answers it. Nothing
should be re-tuned before that number exists — the deployment is what produces the evidence.

**C-5. Total request duration is still unbounded.** Phase 3 unresolved question 4. Harmless for a
curl-driven demo; it becomes real the moment Dialfire is on the other end, since a voice caller
experiences the total, not the upstream portion. Named here so it is not rediscovered in Phase 8.

**C-6. `/health` does not reflect configuration validity.** — **Resolved.** `src/server.ts` now
validates the configuration at startup and exits non-zero when it is missing or malformed, so a
misconfigured release fails at deploy time instead of reporting healthy. `/health` itself is
unchanged and remains a pure liveness probe; smoke test 3 is still the check that proves upstream
credentials actually work. See `D-018`.

---

## Not in this checkpoint

**As originally written:** No deployment performed. No commit. No secrets added or read. No Dialfire
integration, no wrapper, no Dialfire-facing change of any kind. No database. No rate limiter, no
authentication, no startup check, no `engines` pin — each is named above as a decision, not silently
implemented. No change to frozen documentation; this file is new and additive.

**After the deployment-hardening phase**, the rate limiter, the startup check, and the `engines` pin
have since been implemented, and the database exists. Still deliberately absent, and still not to be
added silently:

- **No inbound authentication.** Rejected in `D-018` and unchanged.
- **No answer generation.** `POST /api/rag/query` returns evidence and nothing else.
- **No change to retrieval.** No embeddings, no embedding model or pinned artifact, no chunks, no
  ranking, no threshold, no `maxChunks`, no metadata projection, no evaluation dataset was touched by
  the hardening phase. The only retrieval-adjacent change is the transport the pool connects over.
- **No Dialfire change of any kind.**
- **No deeper readiness endpoint.** `/health` stays a pure liveness probe; §2 explains why.
- **No graceful `SIGTERM` shutdown.** Still open, still acceptable for a demo, still not for
  production.
- **No shared rate-limit counter.** Both limiters remain per-process, which is why the deployment must
  run a single instance.
- **No CA certificate in the repository.** `DATABASE_CA_CERT_PATH` points at a file the operator
  supplies.
- **No deployment performed and no commit made** by that phase either.
