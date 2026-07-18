/**
 * Structured JSON logging, per `coding-standards.md` § Logging.
 *
 * Logged: correlation ID, endpoint, upstream status, both latency metrics, result count, error code,
 * and the raw upstream `status` value whenever it maps to `unknown`.
 *
 * The two latency fields are deliberately distinct and never collapsed into one ambiguous "latency":
 * `upstreamLatencyMs` is the Manufactum call alone, `requestLatencyMs` is total backend handling.
 * See `D-017`.
 *
 * Never logged: the API key, the value of the API-key header, or upstream response bodies. This
 * module accepts only the narrow field set below, so a raw body cannot be passed in by accident.
 */

export type LogFields = {
  correlationId?: string;
  endpoint?: string;
  upstreamStatus?: number;
  /**
   * Time spent on the Manufactum call alone: from issuing the `fetch` until its response headers
   * arrive, or until it fails. It excludes body download, schema validation, and mapping. The
   * configured upstream timeout governs exactly this measurement and nothing wider.
   */
  upstreamLatencyMs?: number;
  /**
   * Total backend handling time: from request entry until the response is completed. On a request
   * that calls upstream this is always the larger of the two, and the difference is the backend's
   * own overhead.
   */
  requestLatencyMs?: number;
  resultCount?: number;
  errorCode?: string;
  /** Technical detail for operators; never returned to a caller. */
  message?: string;
  /** Raw upstream `status` values that mapped to the internal `unknown` status. */
  unmappedUpstreamStatuses?: string[];
};

export type Logger = {
  info: (event: string, fields: LogFields) => void;
  warn: (event: string, fields: LogFields) => void;
  error: (event: string, fields: LogFields) => void;
};

function emit(
  write: (line: string) => void,
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields,
): void {
  const entry: Record<string, unknown> = { level, event };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      entry[key] = value;
    }
  }

  write(JSON.stringify(entry));
}

export const consoleLogger: Logger = {
  info: (event, fields) => emit((line) => console.log(line), "info", event, fields),
  warn: (event, fields) => emit((line) => console.warn(line), "warn", event, fields),
  error: (event, fields) => emit((line) => console.error(line), "error", event, fields),
};
