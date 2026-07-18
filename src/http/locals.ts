/**
 * Per-request values shared between middlewares through `response.locals`.
 *
 * Both are optional in the type because middleware ordering cannot be proven to the compiler; each
 * reader supplies its own fallback.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** Set by the correlation-ID middleware and echoed in the error envelope. */
      correlationId?: string;
      /** Set by the error middleware so the request log line records how the request failed. */
      errorCode?: string;
      /**
       * Set by the integration layer through the request context when an upstream call is made, so
       * the completion log can report upstream time alongside total request time. Absent on a
       * request that never called upstream.
       */
      upstreamLatencyMs?: number;
    }
  }
}

export {};
