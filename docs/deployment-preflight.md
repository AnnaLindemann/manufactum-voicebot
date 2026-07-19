# Test Deployment Preflight

Status: draft. Prepared after Phase 3 acceptance, before any deployment work.

Scope: what the **existing** backend needs in order to run behind a public HTTPS URL for a
controlled demo. It changes no code, adds no dependency, and does not design Phase 4 or the Dialfire
integration. Everything below is derived from the current source and the frozen documentation.

Deployed surface today: `GET /health` and `GET /api/products/search`. Nothing else exists.

---

## 1. Environment variables

Read directly by the running process. There are no others.

| Variable                    | Required | Default | Read where                        | Notes                                                                                                            |
| --------------------------- | -------- | ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | no       | `3000`  | `src/server.ts`                   | Most platforms inject this. Do not hard-code it.                                                                 |
| `MANUFACTUM_API_BASE_URL`   | yes      | —       | `src/config/manufactum-config.ts` | Must parse as a URL. Test-environment base URL.                                                                  |
| `MANUFACTUM_API_KEY`        | yes      | —       | `src/config/manufactum-config.ts` | **Secret.** Test credential only.                                                                                |
| `MANUFACTUM_API_KEY_HEADER` | yes      | —       | `src/config/manufactum-config.ts` | Header name the key is sent under. Not itself secret, but paired.                                                |
| `MANUFACTUM_API_TIMEOUT_MS` | no       | `8000`  | `src/config/manufactum-config.ts` | Set-but-malformed fails loudly; unset takes the default.                                                         |
| `TRUST_PROXY`               | no       | off     | `src/server.ts`                   | Express `trust proxy`. Set only behind a known proxy — it decides which IP the rate limiter counts. See `D-018`. |

`NODE_ENV` is not read anywhere in the codebase. Setting it changes nothing today except Express's
own internals; it is not a configuration switch for this backend.

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

---

## 2. Health and production start

- Start command: `npm run start` → `node dist/server.js`. It requires `npm run build` to have run;
  `dist/` is git-ignored, so the platform must build, not just install.
- Build command: `npm ci && npm run build`. Use `npm ci` — `package-lock.json` is committed.
- `devDependencies` are needed at build time (`typescript`), so a build step that installs production
  dependencies only will fail. Install everything, build, then let the platform prune if it wants.
- `src/server.ts` binds with `app.listen(port)`, i.e. all interfaces. No change needed for a
  container.
- Health check path: `GET /health`, expect `200` and `{"status":"ok"}`
  (`src/app.ts`). It is a liveness signal only — see the lazy-validation risk above.
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

## 3. Public endpoint security

Once the URL is public, `/api/products/search` is reachable by anyone who finds it. What is already
in place, and what is not:

**Already handled by the code** — no work needed:

- input is validated before any upstream call (`INVALID_REQUEST`, no upstream call made);
- `limit` is capped at 5 and `q` at 200 characters, so a single request cannot be inflated;
- upstream status codes and bodies are never forwarded; errors leave as the fixed envelope;
- the API key never appears in a response, an error, or a log line;
- caller-spoken query text is deliberately not logged.

**Real risks that remain:**

| Risk                        | Why it matters here                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No authentication           | The route is fully open. Anyone with the URL can query it. **Accepted deliberately** — a shared token was rejected because Dialfire secret storage is unconfirmed (`D-018`). The rate limit is the compensating control. |
| ~~No rate limiting~~        | **Closed.** 20 requests per minute per client IP on the search route; `/health` exempt. A rejected request makes no upstream call.                                                                                       |
| Upstream cost amplification | Bounded, not eliminated: the limit caps how fast one client can spend our upstream credential. It is per process and in memory, so the deployment must run a **single instance**.                                        |
| No total request budget     | `MANUFACTUM_API_TIMEOUT_MS` bounds the upstream call only. Total handling time is measured but unlimited (Phase 3 unresolved question 4).                                                                                |
| Discoverable URL            | Platform-assigned hostnames are guessable and appear in TLS certificate-transparency logs. Treat the URL as public knowledge, not as a secret.                                                                           |

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
Scheduled jobs and PostgreSQL are on that list but belong to later RAG phases — **no database is
required for this checkpoint** and none should be provisioned now (`D-003`).

The app is a plain stateless Node HTTP server reading `PORT`, with no filesystem state and no native
dependencies. That makes it compatible with essentially any container or Node host. Candidates that
meet every requirement above without code changes:

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

## 6. Contradictions and decisions required

Status after the deployment-readiness patch: **C-1, C-2, and C-6 are resolved** by `D-018` and the
code it records. **C-3 is resolved** by the reproducibility update that followed. C-4 and C-5 remain
open. The original wording is kept below as the record of what the checkpoint found.

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

No deployment performed. No commit. No secrets added or read. No Dialfire integration, no wrapper,
no Dialfire-facing change of any kind. No database. No rate limiter, no authentication, no startup
check, no `engines` pin — each is named above as a decision, not silently implemented. No change to
frozen documentation; this file is new and additive.
