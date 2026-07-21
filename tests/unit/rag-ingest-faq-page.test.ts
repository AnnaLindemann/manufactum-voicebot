import { describe, expect, it } from "vitest";
import { computeDocumentContentHash } from "../../src/rag/prepare-document.js";
import { InMemoryRagDocumentStore } from "../../src/rag/in-memory-document-store.js";
import {
  ingestFaqPage,
  type IngestionMetadata,
  type IngestOptions,
} from "../../src/rag/ingest-faq-page.js";
import type { ExtractedFaqPage } from "../../src/rag/types.js";

/** A small deterministic page. German characters are included on purpose. */
function samplePage(): ExtractedFaqPage {
  return {
    documentKey: "mein-konto",
    pageTitle: "Mein Konto",
    category: "Mein Konto",
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    faqItems: [
      { question: "Wie kann ich mich registrieren?", answer: "Über den Login-Bereich." },
      {
        question: "Welche Vorteile bietet mir ein Konto?",
        answer: "Mit einem Konto genießen Sie:\n• Newsletter\n• Bestellhistorie",
      },
    ],
  };
}

/** A second, independent page under a different key. */
function returnsPage(): ExtractedFaqPage {
  return {
    documentKey: "returns-policy",
    pageTitle: "Rückgabe",
    category: "Rückgabe",
    sourceUrl: "https://www.manufactum.de/ruecksendung/",
    faqItems: [{ question: "Wie sende ich zurück?", answer: "Mit dem Retourenschein." }],
  };
}

function metadata(): IngestionMetadata {
  return {
    documentType: "account-faq",
    language: "de",
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
  };
}

/** A clock that returns a fixed, then incrementing, deterministic timestamp per call. */
function fixedClock(start = 0): IngestOptions {
  let tick = start;
  return {
    now: () => `2026-07-21T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  };
}

describe("ingestFaqPage — initial ingest", () => {
  it("creates active version 1 and its chunks on the first ingest", () => {
    const store = new InMemoryRagDocumentStore();
    const result = ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    expect(result.outcome).toBe("created");
    expect(result.version).toBe(1);
    expect(result.createdNewVersion).toBe(true);

    const doc = store.getDocument("mein-konto");
    expect(doc?.currentVersion).toBe(1);

    const active = store.getActiveVersion("mein-konto");
    expect(active?.version).toBe(1);
    expect(active?.isActive).toBe(true);

    const chunks = store.getActiveChunks("mein-konto");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.isActive)).toBe(true);
  });
});

describe("ingestFaqPage — unchanged ingest", () => {
  it("creates no new version and does not change the active version when the hash is identical", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    const activeBefore = store.getActiveVersion("mein-konto");

    const result = ingestFaqPage(store, samplePage(), metadata(), fixedClock(50));

    expect(result.outcome).toBe("unchanged");
    expect(result.version).toBe(1);
    expect(result.createdNewVersion).toBe(false);

    expect(store.listVersions("mein-konto")).toHaveLength(1);
    // The active version, including its creation time, is untouched by the no-op re-ingest.
    expect(store.getActiveVersion("mein-konto")).toEqual(activeBefore);
  });
});

describe("ingestFaqPage — changed ingest", () => {
  it("creates version 2, activates it, and deactivates version 1", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    const result = ingestFaqPage(store, changed, metadata(), fixedClock(50));

    expect(result.outcome).toBe("created");
    expect(result.version).toBe(2);
    expect(result.createdNewVersion).toBe(true);

    expect(store.getDocument("mein-konto")?.currentVersion).toBe(2);
    expect(store.listVersions("mein-konto").map((version) => version.version)).toEqual([1, 2]);

    expect(store.getVersion("mein-konto", 1)?.isActive).toBe(false);
    expect(store.getVersion("mein-konto", 2)?.isActive).toBe(true);
    expect(store.getActiveVersion("mein-konto")?.version).toBe(2);

    // The document's content hash now mirrors version 2, not version 1.
    expect(store.getDocument("mein-konto")?.contentHash).toBe(computeDocumentContentHash(changed));
  });

  it("keeps inactive version-1 chunks stored and unchanged after version 2 is created", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    const v1ChunksBefore = store.getChunks("mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    ingestFaqPage(store, changed, metadata(), fixedClock(50));

    const v1ChunksAfter = store.getChunks("mein-konto", 1);
    expect(v1ChunksAfter).toHaveLength(2);
    expect(v1ChunksAfter.every((chunk) => chunk.isActive === false)).toBe(true);
    // Byte-for-byte identical to what was stored for version 1 before version 2 existed, except the
    // derived isActive flag (which was true while v1 was active).
    expect(v1ChunksAfter.map((chunk) => ({ ...chunk, isActive: true }))).toEqual(v1ChunksBefore);
    // The original v1 chunk content is preserved, distinct from the edited v2 content.
    expect(v1ChunksAfter[0]?.answer).toBe("Über den Login-Bereich.");
    expect(store.getChunks("mein-konto", 2)[0]?.answer).toBe("Über das Registrierungsformular.");
  });

  it("treats a reverted-but-different active hash as a change (compares against the active version only)", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    ingestFaqPage(store, changed, metadata(), fixedClock(50));

    // Re-ingesting the original content differs from the active (v2) hash, so it becomes v3.
    const reverted = ingestFaqPage(store, samplePage(), metadata(), fixedClock(60));
    expect(reverted.version).toBe(3);
    expect(store.getActiveVersion("mein-konto")?.version).toBe(3);
  });
});

describe("ingestFaqPage — independence of document keys", () => {
  it("versions two document keys independently", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    // Bump mein-konto to v2.
    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    ingestFaqPage(store, changed, metadata(), fixedClock(50));

    // First ingest of a different key must start at v1.
    const other = ingestFaqPage(store, returnsPage(), metadata(), fixedClock(60));
    expect(other.version).toBe(1);

    expect(store.getDocument("mein-konto")?.currentVersion).toBe(2);
    expect(store.getDocument("returns-policy")?.currentVersion).toBe(1);
    expect(store.getActiveChunks("returns-policy")).toHaveLength(1);
    expect(store.getActiveChunks("mein-konto")).toHaveLength(2);
  });
});

describe("ingestFaqPage — chunk keys", () => {
  it("stamps the new version into 1-based chunk keys of the format {key}:v{n}:chunk-00x", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    ingestFaqPage(store, changed, metadata(), fixedClock(50));

    expect(store.getChunks("mein-konto", 1).map((chunk) => chunk.chunkKey)).toEqual([
      "mein-konto:v1:chunk-001",
      "mein-konto:v1:chunk-002",
    ]);
    expect(store.getChunks("mein-konto", 2).map((chunk) => chunk.chunkKey)).toEqual([
      "mein-konto:v2:chunk-001",
      "mein-konto:v2:chunk-002",
    ]);
  });
});

describe("ingestFaqPage — metadata and traceability", () => {
  it("preserves every required traceability field on the version and its chunks", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const version = store.getActiveVersion("mein-konto");
    expect(version).toMatchObject({
      documentKey: "mein-konto",
      version: 1,
      sourceUrl: "https://www.manufactum.de/konto-c201130/",
      title: "Mein Konto",
      documentType: "account-faq",
      language: "de",
      crawlerVersion: "crawler-1.0.0",
      extractorVersion: "extractor-1.0.0",
      isActive: true,
    });
    expect(version?.createdAt).toBe("2026-07-21T00:00:00.000Z");
    expect(version?.contentHash).toBe(computeDocumentContentHash(samplePage()));

    for (const chunk of store.getActiveChunks("mein-konto")) {
      expect(chunk).toMatchObject({
        documentKey: "mein-konto",
        documentVersion: 1,
        sourceUrl: "https://www.manufactum.de/konto-c201130/",
        title: "Mein Konto",
        documentType: "account-faq",
        language: "de",
        crawlerVersion: "crawler-1.0.0",
        extractorVersion: "extractor-1.0.0",
        isActive: true,
      });
      expect(chunk.createdAt).toBe("2026-07-21T00:00:00.000Z");
      expect(typeof chunk.chunkIndex).toBe("number");
      expect(typeof chunk.contentHash).toBe("string");
    }
  });

  it("rejects blank required metadata rather than storing invented values", () => {
    const store = new InMemoryRagDocumentStore();
    expect(() =>
      ingestFaqPage(store, samplePage(), { ...metadata(), language: "" }, fixedClock()),
    ).toThrow(RangeError);
    // Nothing was stored on the rejected ingest.
    expect(store.getDocument("mein-konto")).toBeUndefined();
  });
});

describe("ingestFaqPage — determinism and immutability of inputs", () => {
  it("is deterministic: identical inputs and clock yield identical stored versions", () => {
    const storeA = new InMemoryRagDocumentStore();
    const storeB = new InMemoryRagDocumentStore();
    ingestFaqPage(storeA, samplePage(), metadata(), fixedClock());
    ingestFaqPage(storeB, samplePage(), metadata(), fixedClock());

    expect(storeB.getActiveVersion("mein-konto")).toEqual(storeA.getActiveVersion("mein-konto"));
    expect(storeB.getActiveChunks("mein-konto")).toEqual(storeA.getActiveChunks("mein-konto"));
  });

  it("does not mutate the input page, its faqItems, or the metadata object", () => {
    const store = new InMemoryRagDocumentStore();
    const page = samplePage();
    const meta = metadata();
    const pageSnapshot = structuredClone(page);
    const metaSnapshot = structuredClone(meta);

    ingestFaqPage(store, page, meta, fixedClock());

    expect(page).toEqual(pageSnapshot);
    expect(meta).toEqual(metaSnapshot);
  });

  it("returns frozen views that cannot mutate stored records", () => {
    const store = new InMemoryRagDocumentStore();
    ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const chunk = store.getActiveChunks("mein-konto")[0]!;
    expect(Object.isFrozen(chunk)).toBe(true);
    // A mutation attempt does not change the stored record on the next read.
    expect(() => {
      (chunk as { isActive: boolean }).isActive = false;
    }).toThrow(TypeError);
    expect(store.getActiveChunks("mein-konto")[0]?.isActive).toBe(true);
  });
});
