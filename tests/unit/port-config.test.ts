import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, loadPort } from "../../src/config/port-config.js";

describe("loadPort", () => {
  it("takes the documented default when PORT is unset, as on any host that does not inject one", () => {
    expect(loadPort({})).toBe(DEFAULT_PORT);
  });

  it("takes the default for an empty value, which is what a cleared platform variable leaves", () => {
    expect(loadPort({ PORT: "" })).toBe(DEFAULT_PORT);
    expect(loadPort({ PORT: "   " })).toBe(DEFAULT_PORT);
  });

  it("accepts a valid port, including the one Render injects", () => {
    expect(loadPort({ PORT: "10000" })).toBe(10_000);
    expect(loadPort({ PORT: " 8080 " })).toBe(8_080);
    expect(loadPort({ PORT: "1" })).toBe(1);
    expect(loadPort({ PORT: "65535" })).toBe(65_535);
  });

  it.each([
    ["zero", "0"],
    ["a negative port", "-1"],
    ["a port above the TCP range", "65536"],
    ["a fractional port", "8080.5"],
    ["a typo with a letter O", "8O80"],
    ["a word", "auto"],
    ["a port with a unit", "8080/tcp"],
  ])("rejects %s rather than binding somewhere unexpected", (_label, value) => {
    // Every one of these previously became `NaN` or `0`, both of which Node reads as "bind an
    // OS-assigned ephemeral port": the service starts, reports healthy, and answers on a port nothing
    // is configured to reach.
    expect(() => loadPort({ PORT: value })).toThrow(/PORT/);
  });

  it("names the variable and the accepted range without echoing the value", () => {
    let message = "";

    try {
      loadPort({ PORT: "definitely-not-a-port" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("PORT");
    expect(message).toContain("65535");
    expect(message).not.toContain("definitely-not-a-port");
  });
});
