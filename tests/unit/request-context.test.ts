import { describe, expect, it } from "vitest";
import { createRequestContext } from "../../src/observability/request-context.js";

describe("createRequestContext", () => {
  it("carries the correlation ID and forwards recorded upstream latency", () => {
    const recorded: number[] = [];
    const context = createRequestContext("cid-7", (ms) => recorded.push(ms));

    context.recordUpstreamLatency(42);

    expect(context.correlationId).toBe("cid-7");
    expect(recorded).toEqual([42]);
  });

  it("defaults to a no-op recorder, so a caller that ignores timings still works", () => {
    const context = createRequestContext("cid-8");

    expect(() => context.recordUpstreamLatency(11)).not.toThrow();
    expect(context.correlationId).toBe("cid-8");
  });
});
