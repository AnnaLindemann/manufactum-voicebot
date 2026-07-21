import { describe, expect, it } from "vitest";
import { FaqFetchError } from "../../src/rag/errors.js";
import { fetchPage } from "../../src/rag/fetch-page.js";

/**
 * Network-free: a fake `fetch` records the request and returns a controlled `Response`. No real
 * HTTP call is made, so the test is deterministic and offline.
 */
describe("fetchPage", () => {
  it("sends a browser User-Agent and Accept-Language de-DE, and returns the body on 200", async () => {
    const calls: { url: string | URL | Request; headers: Record<string, string> }[] = [];

    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({
        url: input,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(
        new Response("<html>ok</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    };

    const body = await fetchPage("https://www.manufactum.de/konto-c201130/", {
      fetchImplementation: fakeFetch,
    });

    expect(body).toBe("<html>ok</html>");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://www.manufactum.de/konto-c201130/");
    expect(calls[0]?.headers["Accept-Language"]).toBe("de-DE,de;q=0.9");
    expect(calls[0]?.headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("throws FaqFetchError carrying the status on a non-2xx response", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response("nope", { status: 503 }));

    await expect(
      fetchPage("https://www.manufactum.de/konto-c201130/", { fetchImplementation: fakeFetch }),
    ).rejects.toMatchObject({ name: "FaqFetchError", status: 503 });
  });

  it("throws FaqFetchError on a transport failure", async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new Error("connection refused"));

    await expect(
      fetchPage("https://www.manufactum.de/konto-c201130/", { fetchImplementation: fakeFetch }),
    ).rejects.toBeInstanceOf(FaqFetchError);
  });

  it("accepts a text/html; charset=utf-8 response and returns the body", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response("<html>ok</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );

    const body = await fetchPage("https://www.manufactum.de/konto-c201130/", {
      fetchImplementation: fakeFetch,
    });

    expect(body).toBe("<html>ok</html>");
  });

  it("throws FaqFetchError for a non-HTML 200 response (application/json)", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response('{"error":"nope"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      fetchPage("https://www.manufactum.de/konto-c201130/", { fetchImplementation: fakeFetch }),
    ).rejects.toMatchObject({ name: "FaqFetchError", status: 200 });
  });
});
