// Loaded here rather than in `app.ts`, so importing the app in a test never reads a local `.env`.
import "dotenv/config";
import { app } from "./app.js";
import { loadManufactumConfig } from "./config/manufactum-config.js";
import { loadRagRetrievalConfig } from "./config/rag-retrieval-config.js";

const port = Number(process.env.PORT ?? 3000);

/**
 * Fail fast on missing or malformed configuration, for **every** capability the process serves.
 *
 * Each configuration is otherwise read lazily, inside the request path, so that importing the app for
 * a test or a health check needs neither credentials nor a database. That property is worth keeping,
 * but on a deployment it hid a real failure: a release with missing Manufactum variables still booted
 * and still answered `GET /health` with `200`, so the platform reported it healthy and the fault
 * surfaced only when the first caller received an `INTERNAL_ERROR`. A misconfigured release must fail
 * visibly at deploy time, while a rollback is still the obvious response.
 *
 * `POST /api/rag/query` is checked here for exactly the same reason. It is a registered route from
 * process start, so a release without `DATABASE_URL`, or with a malformed `RAG_RETRIEVAL_MIN_SCORE`,
 * would boot, report healthy, and then answer every retrieval call with `INTERNAL_ERROR` — the
 * identical failure this check exists to prevent. A voice agent would experience it as a knowledge
 * base that exists but never knows anything, which is far harder to diagnose than a failed deploy.
 *
 * The check covers **presence and shape only**. It does not open a connection, does not query
 * pgvector, and does not load the embedding model: a reachability probe at startup would turn a
 * momentarily slow database into a failed release, and the model is a ~118 MB artifact whose load
 * belongs on the first query, not on the boot path. Unreachable-at-runtime therefore remains a `500`,
 * as it must.
 *
 * Both configurations are evaluated even when the first one fails, so an operator fixing a bad
 * release sees every offending variable at once instead of discovering the second on the next deploy.
 *
 * This runs at server start only. It does not change the lazy reads, which stay the single source of
 * truth for the values themselves.
 */
function verifyConfigurationOrExit(): void {
  const failures = [
    configurationFailure(() => loadManufactumConfig()),
    configurationFailure(() => loadRagRetrievalConfig()),
  ].filter((message): message is string => message !== null);

  if (failures.length === 0) {
    return;
  }

  // Every message names the offending variables and never their values; see the two config modules.
  // That matters most here: `MANUFACTUM_API_KEY` is a secret and `DATABASE_URL` carries a password,
  // and a startup log is the one place they would land in a platform's log stream unredacted.
  console.error(
    JSON.stringify({
      level: "error",
      event: "startup_configuration_invalid",
      message: failures.join(" "),
    }),
  );

  // Non-zero, so a platform treats the release as failed rather than as a running service.
  process.exit(1);
}

/** Runs one configuration loader, returning its message on failure and `null` on success. */
function configurationFailure(load: () => unknown): string | null {
  try {
    load();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Unknown configuration error.";
  }
}

verifyConfigurationOrExit();

/**
 * Enabled only when `TRUST_PROXY` is set, because the rate limiter counts against `request.ip`.
 * Trusting `X-Forwarded-For` where no proxy sets it would let any caller forge a new identity per
 * request and bypass the limiter; leaving it off behind a real proxy only makes the limit stricter.
 * Off is therefore the safe default, and this must be set once the deployment topology is known.
 */
const trustProxy = process.env.TRUST_PROXY?.trim();

if (trustProxy !== undefined && trustProxy !== "") {
  app.set("trust proxy", trustProxy);
}

app.listen(port, () => {
  console.log(`Manufactum Voicebot backend is listening on port ${port}`);
});
