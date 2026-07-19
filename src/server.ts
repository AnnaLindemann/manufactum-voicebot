// Loaded here rather than in `app.ts`, so importing the app in a test never reads a local `.env`.
import "dotenv/config";
import { app } from "./app.js";
import { loadManufactumConfig } from "./config/manufactum-config.js";

const port = Number(process.env.PORT ?? 3000);

/**
 * Fail fast on missing or malformed upstream configuration.
 *
 * The configuration is otherwise read lazily, inside the request path, so that importing the app for
 * a test or a health check needs no credentials. That property is worth keeping, but on a deployment
 * it hid a real failure: a release with missing Manufactum variables still booted and still answered
 * `GET /health` with `200`, so the platform reported it healthy and the fault surfaced only when the
 * first caller received an `INTERNAL_ERROR`. A misconfigured release must fail visibly at deploy
 * time, while a rollback is still the obvious response.
 *
 * This runs at server start only. It does not change the lazy read in the client, which stays the
 * single source of truth for the values themselves.
 */
function verifyConfigurationOrExit(): void {
  try {
    loadManufactumConfig();
  } catch (error) {
    // The message names the missing variables and never their values; see `manufactum-config.ts`.
    console.error(
      JSON.stringify({
        level: "error",
        event: "startup_configuration_invalid",
        message: error instanceof Error ? error.message : "Unknown configuration error.",
      }),
    );

    // Non-zero, so a platform treats the release as failed rather than as a running service.
    process.exit(1);
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
