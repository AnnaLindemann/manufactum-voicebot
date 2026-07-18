/**
 * Per-request observability context threaded from the route down to the integration layer.
 *
 * It carries the correlation ID and a sink for timings the lower layers measure but cannot log in
 * the completion line themselves. Deliberately free of any Express type, so the integration layer
 * stays independent of the HTTP layer.
 */
export type RequestContext = {
  correlationId: string;
  /**
   * Called by the integration layer once an upstream call has produced a response or failed, with
   * the time spent on that call alone. The HTTP layer records it so the request-completion log line
   * can report upstream time and total time side by side.
   */
  recordUpstreamLatency: (upstreamLatencyMs: number) => void;
};

/** A context for code paths that make no upstream call, and for tests that assert nothing about it. */
export function createRequestContext(
  correlationId: string,
  recordUpstreamLatency: (upstreamLatencyMs: number) => void = () => undefined,
): RequestContext {
  return { correlationId, recordUpstreamLatency };
}
