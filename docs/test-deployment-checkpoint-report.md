# Test Deployment Checkpoint — Implementation Report

## Checkpoint

Test Deployment readiness. A **separate checkpoint** taken after accepted Phase 3, not Phase 4 and
not Phase 7 pulled forward. See `D-018`.

## Summary

This patch makes the existing backend safe to expose at a public HTTPS URL for a controlled demo. It
adds nothing to the API surface: `GET /health` and `GET /api/products/search` remain the only routes,
and the product-search contract is untouched.

Two changes, both from the preflight findings:

1. **Fail-fast startup configuration validation.** A release with missing Manufactum variables used
   to boot, answer `/health` with `200`, and be reported healthy by the platform, failing only when
   the first caller received an `INTERNAL_ERROR`. It now exits non-zero at startup.
2. **Rate limiting on `GET /api/products/search`** — 20 requests per minute per client IP, returning
   the new `RATE_LIMITED` error code as the standard envelope.

The rate limit is the compensating control for a deliberate decision: the endpoint stays
**unauthenticated**. A shared inbound token was rejected because Dialfire's secret storage is
unconfirmed, and a token held in a Dialfire script would not be secure.

## Files changed

Source:

- `src/server.ts` — startup configuration check that exits non-zero on failure; optional
  `TRUST_PROXY` handling.
- `src/http/rate-limit.ts` — **new.** Fixed-window per-IP limiter.
- `src/app.ts` — limiter mounted on the search path only, after correlation ID and request logging,
  with `/health` deliberately registered before it; injectable through `AppDependencies`.
- `src/errors/app-error.ts` — `RATE_LIMITED` added to the code table (HTTP `429`, retryable) and
  `429` added to the internal status union.

Tests:

- `tests/unit/rate-limit.test.ts` — **new.** 10 tests on a controlled clock.
- `tests/integration/startup-configuration.test.ts` — **new.** 6 tests running the real entry point
  as a child process.
- `tests/integration/product-search-route.test.ts` — a `rate limiting` block of 7 tests;
  `createTestApp` accepts an injected limiter.
- `tests/unit/app-error.test.ts` — contract table and the fixed-status-set assertion extended
  with `429`.

Documentation:

- `docs/api-contracts.md` — `RATE_LIMITED` row; internal status set widened to include `429`;
  retryable rule restated; new § Rate limiting.
- `docs/project-decisions.md` — `D-018` added.
- `docs/deployment-preflight.md` — C-1, C-2, C-6 marked resolved; §1 `TRUST_PROXY` row; §3 risk table
  and safeguard list updated; new smoke test 8 for the rate limit.
- `.env.example` — `TRUST_PROXY` documented as optional.

No dependency was added.

### Reproducibility update

A follow-up change pins the runtime, closing C-3:

- `package.json` — `engines.node` set to `^24.11.0`: at or above the locally verified 24.11.0, below
  25, and satisfied by Render's current 24.14.1 runtime. A range rather than an exact version,
  because the local and platform patch levels differ and an exact pin would have to be wrong for one
  of them. `engines.node` alone is the pin — no `.nvmrc` or `.node-version` file — so there is a
  single place to change it. No dependency, script, or application behaviour changed.

## Checks and tests run

`npm run check` — typecheck, lint, format check, tests, build. See the run log below for results.

`git diff --check` — no whitespace errors.

## Assumptions

1. The Test Deployment runs a **single instance**. The counter is in memory and per process, so more
   instances multiply the effective limit.
2. 20 requests per minute is adequate for a supervised demo with a handful of testers. It was given
   as an agreed policy, not derived from measured demand.
3. `tsx` is available for the startup tests, which run the entry point as a child process. It is
   already a devDependency.

## Limitations

1. **The endpoint is unauthenticated.** Anyone with the URL can query it, at up to 20 requests per
   minute. This is a deliberate, recorded decision, not an oversight.
2. **The limit is per process and in memory.** It does not survive a restart and is not shared
   between instances. A shared counter is Phase 16 work.
3. **The window is fixed, not sliding.** Up to 40 requests can pass across a window boundary.
4. **The limiter caps rate, not total volume.** A patient caller can still spend a large number of
   upstream calls over hours. An upstream quota or spend limit is the control for that, and it is
   operational rather than code.
5. **`TRUST_PROXY` is unset by default**, so behind an un-configured proxy every caller shares one
   bucket and the limit is effectively global. That direction is safe but restrictive; the variable
   must be set once the platform is known.
6. The bucket-map sweep is not directly asserted by a test, because asserting it would mean exposing
   the internal map. Its effect on behaviour is covered.
7. The startup check validates that configuration is **present and well-formed**. It does not verify
   the credential works — only a real upstream call does that, which is smoke test 3.

## Unresolved questions

Carried forward from the preflight:

1. **C-4** — the 8-second upstream timeout is calibrated against dev measurements only. Smoke test 3
   produces the number that answers it.
2. **C-5** — total request duration is still unbounded; only the upstream call is bounded. Harmless
   under curl, real once Dialfire is on the other end.

New:

3. Should the rate limit be raised, lowered, or scoped differently once real demo traffic is
   observed? 20/minute was agreed in advance, not measured.
4. Should a rejected request raise an alert rather than only a log line once monitoring exists in
   Phase 16? This is the same question `D-016` left open for `UPSTREAM_REJECTED_REQUEST`. A sustained
   run of `RATE_LIMITED` on an unauthenticated public endpoint is the signal that someone is probing
   it, and nothing currently surfaces that.

**C-3 is closed** by the reproducibility update below: `engines.node` is `^24.11.0`.

## Documentation changes

Listed under **Files changed**. All record decisions or newly implemented behaviour; none alters
observed upstream evidence, and the Phase 3 report was not rewritten.

## Recommendation for the next phase

The backend is ready to be deployed to a public test URL. Before that happens, two operational items
remain, neither of which is code:

- choose a hosting platform (§4 of the preflight, deliberately not chosen here);
- confirm the deployment runs a single instance, and set `TRUST_PROXY` to match its topology.

After deployment, run the nine smoke tests in `deployment-preflight.md` § 5 in order. Smoke test 3
produces the latency figure that closes C-4.

The next **roadmap** phase remains Phase 4 — Store Resolution. This checkpoint does not advance it.
