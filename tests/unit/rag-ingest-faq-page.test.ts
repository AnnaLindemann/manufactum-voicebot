import { describe, expect, it } from "vitest";
import type { EmbeddingModelRef } from "../../src/rag/document-store.js";
import {
  embeddingProfileMetadata,
  embeddingProfileModelRef,
} from "../../src/rag/embedding-profile.js";
import { computeDocumentContentHash } from "../../src/rag/prepare-document.js";
import {
  InMemoryRagDocumentStore,
  RagStorageError,
} from "../../src/rag/in-memory-document-store.js";
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

const MODEL: EmbeddingModelRef = embeddingProfileModelRef();
const PROFILE_METADATA = embeddingProfileMetadata();

/**
 * Drive a staged version to active the way a later phase would: embed every chunk for MODEL, then
 * activate. Ingestion itself only stages, so tests use this to reach an active state.
 */
async function activate(
  store: InMemoryRagDocumentStore,
  documentKey: string,
  version: number,
): Promise<void> {
  const chunks = await store.getChunks(documentKey, version);
  await store.saveChunkEmbeddings(
    chunks.map((chunk) => ({
      documentKey,
      documentVersion: version,
      chunkIndex: chunk.chunkIndex,
      ...PROFILE_METADATA,
      inputHash: `input-${documentKey}-v${String(version)}-${String(chunk.chunkIndex)}`,
      chunkContentHash: chunk.contentHash,
      embedding: Array.from({ length: PROFILE_METADATA.embeddingDim }, () => 0.1),
      createdAt: "2026-07-21T00:00:10.000Z",
    })),
  );
  await store.activateVersion(documentKey, version, MODEL);
}

describe("ingestFaqPage — initial ingest stages version 1", () => {
  it("stages version 1 and its chunks without activating them", async () => {
    const store = new InMemoryRagDocumentStore();
    const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    expect(result.outcome).toBe("staged");
    expect(result.version).toBe(1);
    expect(result.stagedNewVersion).toBe(true);

    // Staged, not active: no document header or active version yet.
    expect(await store.getDocument("mein-konto")).toBeUndefined();
    expect(await store.getActiveVersion("mein-konto")).toBeUndefined();

    const staged = await store.getStagedVersion("mein-konto");
    expect(staged?.version).toBe(1);
    expect(staged?.isActive).toBe(false);
    expect(await store.getChunks("mein-konto", 1)).toHaveLength(2);
  });
});

describe("ingestFaqPage — unchanged ingest", () => {
  it("re-staging identical content while a version is staged is a no-op", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    const stagedBefore = await store.getStagedVersion("mein-konto");

    const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock(50));

    expect(result.outcome).toBe("unchanged");
    expect(result.version).toBe(1);
    expect(result.stagedNewVersion).toBe(false);
    expect(await store.listVersions("mein-konto")).toHaveLength(1);
    expect(await store.getStagedVersion("mein-konto")).toEqual(stagedBefore);
  });

  it("re-ingesting content identical to the active version creates no new version", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);
    const activeBefore = await store.getActiveVersion("mein-konto");

    const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock(50));

    expect(result.outcome).toBe("unchanged");
    expect(result.version).toBe(1);
    expect(await store.listVersions("mein-konto")).toHaveLength(1);
    expect(await store.getActiveVersion("mein-konto")).toEqual(activeBefore);
  });
});

describe("ingestFaqPage — changed ingest", () => {
  it("stages version 2 after version 1 is active, leaving version 1 active until activation", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    const result = await ingestFaqPage(store, changed, metadata(), fixedClock(50));

    expect(result.outcome).toBe("staged");
    expect(result.version).toBe(2);
    expect(result.stagedNewVersion).toBe(true);

    // Version 1 stays active until version 2 is activated; version 2 is merely staged.
    expect((await store.getActiveVersion("mein-konto"))?.version).toBe(1);
    expect((await store.getStagedVersion("mein-konto"))?.version).toBe(2);
    expect((await store.listVersions("mein-konto")).map((v) => v.version)).toEqual([1, 2]);
  });

  it("refuses to stage different content while a version is still staged", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    // Version 1 is staged but not activated, so a different version 2 cannot be staged over it.
    await expect(ingestFaqPage(store, changed, metadata(), fixedClock(50))).rejects.toThrow(
      RagStorageError,
    );
  });

  it("keeps inactive version-1 chunks stored and unchanged after version 2 becomes active", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);
    const v1ChunksBefore = await store.getChunks("mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    await ingestFaqPage(store, changed, metadata(), fixedClock(50));
    await activate(store, "mein-konto", 2);

    const v1ChunksAfter = await store.getChunks("mein-konto", 1);
    expect(v1ChunksAfter).toHaveLength(2);
    expect(v1ChunksAfter.every((chunk) => chunk.isActive === false)).toBe(true);
    expect(v1ChunksAfter.map((chunk) => ({ ...chunk, isActive: true }))).toEqual(v1ChunksBefore);
    expect(v1ChunksAfter[0]?.answer).toBe("Über den Login-Bereich.");
    expect((await store.getChunks("mein-konto", 2))[0]?.answer).toBe(
      "Über das Registrierungsformular.",
    );
  });

  it("treats a reverted-but-different active hash as a change (compares against the active version)", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    await ingestFaqPage(store, changed, metadata(), fixedClock(50));
    await activate(store, "mein-konto", 2);

    // Re-ingesting the original content differs from the active (v2) hash, so it stages v3.
    const reverted = await ingestFaqPage(store, samplePage(), metadata(), fixedClock(60));
    expect(reverted.outcome).toBe("staged");
    expect(reverted.version).toBe(3);
    expect((await store.getStagedVersion("mein-konto"))?.version).toBe(3);
  });
});

describe("ingestFaqPage — independence of document keys", () => {
  it("stages two document keys independently, each starting at version 1", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    await ingestFaqPage(store, changed, metadata(), fixedClock(50));

    const other = await ingestFaqPage(store, returnsPage(), metadata(), fixedClock(60));
    expect(other.version).toBe(1);

    expect((await store.getActiveVersion("mein-konto"))?.version).toBe(1);
    expect((await store.getStagedVersion("mein-konto"))?.version).toBe(2);
    expect((await store.getStagedVersion("returns-policy"))?.version).toBe(1);
    expect(await store.getChunks("returns-policy", 1)).toHaveLength(1);
  });
});

describe("ingestFaqPage — chunk keys", () => {
  it("stamps the new version into 1-based chunk keys of the format {key}:v{n}:chunk-00x", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
    await activate(store, "mein-konto", 1);

    const changed = samplePage();
    changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
    await ingestFaqPage(store, changed, metadata(), fixedClock(50));

    expect((await store.getChunks("mein-konto", 1)).map((chunk) => chunk.chunkKey)).toEqual([
      "mein-konto:v1:chunk-001",
      "mein-konto:v1:chunk-002",
    ]);
    expect((await store.getChunks("mein-konto", 2)).map((chunk) => chunk.chunkKey)).toEqual([
      "mein-konto:v2:chunk-001",
      "mein-konto:v2:chunk-002",
    ]);
  });
});

describe("ingestFaqPage — metadata and traceability", () => {
  it("preserves every required traceability field on the staged version and its chunks", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const version = await store.getStagedVersion("mein-konto");
    expect(version).toMatchObject({
      documentKey: "mein-konto",
      version: 1,
      sourceUrl: "https://www.manufactum.de/konto-c201130/",
      title: "Mein Konto",
      documentType: "account-faq",
      language: "de",
      crawlerVersion: "crawler-1.0.0",
      extractorVersion: "extractor-1.0.0",
      isActive: false,
    });
    expect(version?.createdAt).toBe("2026-07-21T00:00:00.000Z");
    expect(version?.contentHash).toBe(computeDocumentContentHash(samplePage()));

    for (const chunk of await store.getChunks("mein-konto", 1)) {
      expect(chunk).toMatchObject({
        documentKey: "mein-konto",
        documentVersion: 1,
        sourceUrl: "https://www.manufactum.de/konto-c201130/",
        title: "Mein Konto",
        documentType: "account-faq",
        language: "de",
        crawlerVersion: "crawler-1.0.0",
        extractorVersion: "extractor-1.0.0",
        isActive: false,
      });
      expect(chunk.createdAt).toBe("2026-07-21T00:00:00.000Z");
      expect(typeof chunk.chunkIndex).toBe("number");
      expect(typeof chunk.contentHash).toBe("string");
    }
  });

  it("rejects blank required metadata rather than storing invented values", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      ingestFaqPage(store, samplePage(), { ...metadata(), language: "" }, fixedClock()),
    ).rejects.toThrow(RangeError);
    // Nothing was stored on the rejected ingest.
    expect(await store.getStagedVersion("mein-konto")).toBeUndefined();
  });
});

describe("ingestFaqPage — determinism and immutability of inputs", () => {
  it("is deterministic: identical inputs and clock yield identical staged versions", async () => {
    const storeA = new InMemoryRagDocumentStore();
    const storeB = new InMemoryRagDocumentStore();
    await ingestFaqPage(storeA, samplePage(), metadata(), fixedClock());
    await ingestFaqPage(storeB, samplePage(), metadata(), fixedClock());

    expect(await storeB.getStagedVersion("mein-konto")).toEqual(
      await storeA.getStagedVersion("mein-konto"),
    );
    expect(await storeB.getChunks("mein-konto", 1)).toEqual(
      await storeA.getChunks("mein-konto", 1),
    );
  });

  it("does not mutate the input page, its faqItems, or the metadata object", async () => {
    const store = new InMemoryRagDocumentStore();
    const page = samplePage();
    const meta = metadata();
    const pageSnapshot = structuredClone(page);
    const metaSnapshot = structuredClone(meta);

    await ingestFaqPage(store, page, meta, fixedClock());

    expect(page).toEqual(pageSnapshot);
    expect(meta).toEqual(metaSnapshot);
  });

  it("returns frozen views that cannot mutate stored records", async () => {
    const store = new InMemoryRagDocumentStore();
    await ingestFaqPage(store, samplePage(), metadata(), fixedClock());

    const chunk = (await store.getChunks("mein-konto", 1))[0]!;
    expect(Object.isFrozen(chunk)).toBe(true);
    expect(() => {
      (chunk as { isActive: boolean }).isActive = true;
    }).toThrow(TypeError);
    expect((await store.getChunks("mein-konto", 1))[0]?.isActive).toBe(false);
  });
});
