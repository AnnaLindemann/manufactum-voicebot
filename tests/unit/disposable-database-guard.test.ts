import { describe, expect, it } from "vitest";
import {
  assertConnectedDisposableDatabase,
  assertDisposableTestDatabase,
  parseDatabaseIdentity,
} from "../helpers/disposable-database.js";

const WORKING = "postgresql://user:pw@localhost:5432/postgres";
const DISPOSABLE = "postgresql://user:pw@localhost:5432/manufactum_rag_test";

describe("parseDatabaseIdentity", () => {
  it("normalizes host, default port, and database name", () => {
    expect(parseDatabaseIdentity("postgresql://u:p@LocalHost/Manufactum_Rag_Test")).toEqual({
      hostPort: "localhost:5432",
      database: "manufactum_rag_test",
      raw: "postgresql://u:p@LocalHost/Manufactum_Rag_Test",
    });
  });

  it("returns undefined for unset or blank", () => {
    expect(parseDatabaseIdentity(undefined)).toBeUndefined();
    expect(parseDatabaseIdentity("   ")).toBeUndefined();
  });
});

describe("assertDisposableTestDatabase — rejects unsafe configurations", () => {
  it("throws when the test URL is unset", () => {
    expect(() => assertDisposableTestDatabase(undefined, WORKING)).toThrow(/must be set/i);
  });

  it("throws when the disposable database name does not end with _test", () => {
    expect(() =>
      assertDisposableTestDatabase("postgresql://u:p@localhost:5432/scratch", WORKING),
    ).toThrow(/_test/);
  });

  it("throws when test and working are the same raw string", () => {
    expect(() => assertDisposableTestDatabase(WORKING + "_test", WORKING + "_test")).toThrow(
      /same database/i,
    );
  });

  it("throws when test and working resolve to the same database despite differing strings", () => {
    // Same host:port/db, but a trailing slash and different credentials in the string.
    const working = "postgresql://alice:secret@localhost:5432/shared_test";
    const test = "postgresql://bob:other@localhost:5432/shared_test/";
    expect(() => assertDisposableTestDatabase(test, working)).toThrow(/same database/i);
  });
});

describe("assertDisposableTestDatabase — accepts a distinct disposable database", () => {
  it("returns the parsed identity when working and test differ", () => {
    expect(assertDisposableTestDatabase(DISPOSABLE, WORKING)).toEqual({
      hostPort: "localhost:5432",
      database: "manufactum_rag_test",
      raw: DISPOSABLE,
    });
  });

  it("accepts when no working URL is set (nothing to collide with)", () => {
    expect(assertDisposableTestDatabase(DISPOSABLE, undefined).database).toBe(
      "manufactum_rag_test",
    );
  });
});

describe("assertConnectedDisposableDatabase — runtime net", () => {
  const info = (database: string) => ({ database, serverAddr: "127.0.0.1", serverPort: 5432 });

  it("passes when actually connected to the disposable database", () => {
    expect(() =>
      assertConnectedDisposableDatabase(info("manufactum_rag_test"), DISPOSABLE, WORKING),
    ).not.toThrow();
  });

  it("throws when the connected database is the working database on the same server", () => {
    expect(() => assertConnectedDisposableDatabase(info("postgres"), DISPOSABLE, WORKING)).toThrow(
      /working RAG database|does not end with "_test"/,
    );
  });

  it("throws when the connected database name lacks the _test suffix", () => {
    expect(() =>
      assertConnectedDisposableDatabase(info("production"), DISPOSABLE, WORKING),
    ).toThrow(/_test/);
  });

  it("throws when connected to a _test database other than the configured one", () => {
    expect(() =>
      assertConnectedDisposableDatabase(info("other_test"), DISPOSABLE, WORKING),
    ).toThrow(/not the configured disposable database/);
  });
});
