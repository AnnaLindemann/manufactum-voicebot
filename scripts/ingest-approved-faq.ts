import "dotenv/config";
import pg from "pg";
import { extractFaqPage } from "../src/rag/extract-faq.js";
import { fetchPage } from "../src/rag/fetch-page.js";
import { ingestFaqPage, type IngestionMetadata } from "../src/rag/ingest-faq-page.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";
import { computeDocumentContentHash, prepareDocument } from "../src/rag/prepare-document.js";
import type { ExtractedFaqPage, FaqSourceMetadata } from "../src/rag/types.js";

/**
 * Offline ingestion command for one approved Manufactum FAQ source (roadmap Phase 10–11).
 *
 * It only *composes* the existing production pipeline — `fetchPage` (network) → `extractFaqPage`
 * (deterministic extraction) → `ingestFaqPage` (change detection + versioned staging via the store) —
 * and never re-implements fetching, extraction, hashing, chunking, or storage, and never runs raw SQL.
 *
 * It performs the **staging** step only: it stages document version 1 and its chunks. It does NOT
 * create embeddings and does NOT activate the version (those are `rag:embed-staged`). By default it is
 * a dry run (fetch + extract + prepare + report, no database writes); pass `--stage` to also stage the
 * version and prove idempotency by re-staging the identical extracted page.
 *
 * The connection string is read from `DATABASE_URL` and never printed.
 */

/** The approved source, transcribed from `docs/source-registry.md` → "Approved sources → mein-konto". */
const APPROVED_SOURCE = {
  documentKey: "mein-konto",
  url: "https://www.manufactum.de/konto-c201130/",
  category: "Mein Konto",
  documentType: "account-faq",
  language: "de",
} as const;

/** Only this host is acceptable; a redirect off it aborts before any database write. */
const EXPECTED_HOST = "www.manufactum.de";

/** Process-version tags stored for traceability (not part of the content hash). */
const CRAWLER_VERSION = "manufactum-static-fetch/1.0.0";
const EXTRACTOR_VERSION = "manufactum-faq-accordion/1.0.0";

type FetchMeta = {
  status: number;
  finalUrl: string;
  contentType: string | null;
  contentLength: string | null;
  bodyBytes: number;
};

async function fetchApprovedPage(): Promise<{ html: string; meta: FetchMeta }> {
  const captured: Partial<FetchMeta> = {};
  // Inject an observing fetch so the production `fetchPage` (with its status/content-type checks) is
  // still what downloads and validates the page; we only record the response metadata as it passes.
  const observingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    captured.status = response.status;
    captured.finalUrl = response.url;
    captured.contentType = response.headers.get("content-type");
    captured.contentLength = response.headers.get("content-length");
    return response;
  };

  const html = await fetchPage(APPROVED_SOURCE.url, { fetchImplementation: observingFetch });
  const meta: FetchMeta = {
    status: captured.status ?? 0,
    finalUrl: captured.finalUrl ?? APPROVED_SOURCE.url,
    contentType: captured.contentType ?? null,
    contentLength: captured.contentLength ?? null,
    bodyBytes: Buffer.byteLength(html, "utf8"),
  };
  return { html, meta };
}

/** Fail before any database write if the fetch/extraction looks unsafe or low quality. */
function assertUsable(meta: FetchMeta, page: ExtractedFaqPage): void {
  const host = new URL(meta.finalUrl).hostname.toLowerCase();
  if (host !== EXPECTED_HOST) {
    throw new Error(`Redirected to an unexpected host "${host}"; expected "${EXPECTED_HOST}".`);
  }
  if (page.faqItems.length === 0) {
    throw new Error("Extraction produced no FAQ items.");
  }
  for (const [index, item] of page.faqItems.entries()) {
    if (item.question.trim().length === 0 || item.answer.trim().length === 0) {
      throw new Error(`FAQ item ${String(index + 1)} has an empty question or answer.`);
    }
  }
}

/** Heuristic noise probes, reported for judgement (not hard failures). */
function noiseProbes(page: ExtractedFaqPage): Record<string, number> {
  const haystack = page.faqItems
    .map((i) => `${i.question}\n${i.answer}`)
    .join("\n")
    .toLowerCase();
  const probe = (needle: string) => (haystack.match(new RegExp(needle, "g")) ?? []).length;
  return {
    cookie: probe("cookie"),
    warenkorb: probe("warenkorb"),
    impressum: probe("impressum"),
    htmlAngleBrackets: probe("<[a-z/]"),
    scriptWord: probe("function\\s*\\("),
  };
}

function metadata(): IngestionMetadata {
  return {
    documentType: APPROVED_SOURCE.documentType,
    language: APPROVED_SOURCE.language,
    crawlerVersion: CRAWLER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

async function main(): Promise<void> {
  const stage = process.argv.includes("--stage");

  const { html, meta } = await fetchApprovedPage();

  const source: FaqSourceMetadata = {
    documentKey: APPROVED_SOURCE.documentKey,
    category: APPROVED_SOURCE.category,
    sourceUrl: APPROVED_SOURCE.url,
  };
  const page = extractFaqPage(html, source);
  assertUsable(meta, page);

  const prepared = prepareDocument(page, 1);
  const documentContentHash = computeDocumentContentHash(page);

  const report: Record<string, unknown> = {
    mode: stage ? "stage" : "dry-run",
    fetch: meta,
    source: {
      ...APPROVED_SOURCE,
      crawlerVersion: CRAWLER_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
    },
    extraction: {
      title: page.pageTitle,
      faqItemCount: page.faqItems.length,
      preparedChunkCount: prepared.chunks.length,
      documentContentHash,
      chunks: prepared.chunks.map((c) => ({
        chunkKey: c.chunkKey,
        chunkIndex: c.chunkIndex,
        contentHash: c.contentHash,
        questionPreview: c.question.slice(0, 90),
        answerCharacters: c.answer.length,
      })),
      firstChunkContentPreview: prepared.chunks[0]?.content.slice(0, 300) ?? "",
    },
    noiseProbes: noiseProbes(page),
  };

  if (!stage) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set to stage the approved FAQ page.");
  }
  const pool = new pg.Pool({ connectionString });
  try {
    const store = new PostgresRagDocumentStore(pool);

    const first = await ingestFaqPage(store, page, metadata());
    const second = await ingestFaqPage(store, page, metadata()); // idempotency: identical content

    const doc = await store.getDocument(APPROVED_SOURCE.documentKey);
    const staged = await store.getStagedVersion(APPROVED_SOURCE.documentKey);
    const versions = await store.listVersions(APPROVED_SOURCE.documentKey);
    const stagedChunks =
      staged === undefined
        ? []
        : await store.getChunks(APPROVED_SOURCE.documentKey, staged.version);
    const embeddings =
      staged === undefined
        ? []
        : await store.getChunkEmbeddings(APPROVED_SOURCE.documentKey, staged.version);

    report.staging = {
      firstOutcome: first.outcome,
      firstVersion: first.version,
      secondOutcome: second.outcome,
      secondVersion: second.version,
      idempotent:
        second.outcome === "unchanged" && !second.stagedNewVersion && versions.length === 1,
      document: doc, // undefined until activation (a staged new key has no active header)
      documentHeaderExists: doc !== undefined,
      versionCount: versions.length,
      stagedVersion: staged
        ? {
            version: staged.version,
            isActive: staged.isActive,
            title: staged.title,
            sourceUrl: staged.sourceUrl,
            documentType: staged.documentType,
            language: staged.language,
            crawlerVersion: staged.crawlerVersion,
            extractorVersion: staged.extractorVersion,
            contentHash: staged.contentHash,
          }
        : null,
      stagedChunkCount: stagedChunks.length,
      embeddingCount: embeddings.length,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
