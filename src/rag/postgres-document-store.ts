import type { Pool, PoolClient } from "pg";
import type {
  NewVersionInput,
  RagDocumentStore,
  StoredChunk,
  StoredDocument,
  StoredDocumentVersion,
} from "./document-store.js";
import { RagStorageError } from "./in-memory-document-store.js";

/**
 * PostgreSQL implementation of `RagDocumentStore` (`D-004`).
 *
 * Persists documents, immutable versions, and immutable chunks in the schema created by
 * `migrations/`. It is a drop-in replacement for `InMemoryRagDocumentStore`: the ingestion flow and
 * its change-detection logic are unchanged, and this store enforces the same versioning invariants.
 *
 * Immutability is structural. Old versions and chunks are never updated or deleted (the migration
 * even installs triggers forbidding it); "active" is derived on read by comparing a version number to
 * `rag_documents.current_version`, never stored as a mutable flag. A new version, its chunks, and the
 * advance of `current_version` are written in a single transaction, so a partial version is never
 * observable.
 *
 * The caller supplies an already-configured `pg.Pool`; this class never reads a connection string or
 * any secret and never logs one.
 */

/** Shape of a joined version row, with `is_active` derived from `rag_documents.current_version`. */
type VersionRow = {
  document_key: string;
  version: number;
  source_url: string;
  title: string;
  document_type: string;
  language: string;
  content: string;
  content_hash: string;
  crawler_version: string;
  extractor_version: string;
  created_at: Date;
  is_active: boolean;
};

/** Shape of a joined chunk row, with `is_active` derived from `rag_documents.current_version`. */
type ChunkRow = {
  document_key: string;
  document_version: number;
  chunk_index: number;
  chunk_key: string;
  question: string;
  answer: string;
  content: string;
  content_hash: string;
  source_url: string;
  title: string;
  document_type: string;
  language: string;
  crawler_version: string;
  extractor_version: string;
  created_at: Date;
  is_active: boolean;
};

/** Columns selected for a version, aliasing `is_active` from the document's current version. */
const VERSION_COLUMNS = `
  v.document_key, v.version, v.source_url, v.title, v.document_type, v.language,
  v.content, v.content_hash, v.crawler_version, v.extractor_version, v.created_at,
  (v.version = d.current_version) AS is_active
`;

/** Columns selected for a chunk, aliasing `is_active` from the document's current version. */
const CHUNK_COLUMNS = `
  c.document_key, c.document_version, c.chunk_index, c.chunk_key, c.question, c.answer,
  c.content, c.content_hash, c.source_url, c.title, c.document_type, c.language,
  c.crawler_version, c.extractor_version, c.created_at,
  (c.document_version = d.current_version) AS is_active
`;

export class PostgresRagDocumentStore implements RagDocumentStore {
  constructor(private readonly pool: Pool) {}

  async getDocument(documentKey: string): Promise<StoredDocument | undefined> {
    const result = await this.pool.query<{
      document_key: string;
      current_version: number;
      doc_created_at: Date;
      source_url: string;
      title: string;
      document_type: string;
      language: string;
      content_hash: string;
      version_created_at: Date;
    }>(
      `SELECT d.document_key, d.current_version, d.created_at AS doc_created_at,
              v.source_url, v.title, v.document_type, v.language, v.content_hash,
              v.created_at AS version_created_at
         FROM rag_documents d
         JOIN rag_document_versions v
           ON v.document_key = d.document_key AND v.version = d.current_version
        WHERE d.document_key = $1`,
      [documentKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return Object.freeze({
      documentKey: row.document_key,
      sourceUrl: row.source_url,
      title: row.title,
      documentType: row.document_type,
      language: row.language,
      currentVersion: row.current_version,
      contentHash: row.content_hash,
      createdAt: row.doc_created_at.toISOString(),
      lastChangedAt: row.version_created_at.toISOString(),
    });
  }

  async getActiveVersion(documentKey: string): Promise<StoredDocumentVersion | undefined> {
    const result = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM rag_document_versions v
         JOIN rag_documents d ON d.document_key = v.document_key
        WHERE v.document_key = $1 AND v.version = d.current_version`,
      [documentKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapVersion(row);
  }

  async getVersion(
    documentKey: string,
    version: number,
  ): Promise<StoredDocumentVersion | undefined> {
    const result = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM rag_document_versions v
         JOIN rag_documents d ON d.document_key = v.document_key
        WHERE v.document_key = $1 AND v.version = $2`,
      [documentKey, version],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapVersion(row);
  }

  async listVersions(documentKey: string): Promise<StoredDocumentVersion[]> {
    const result = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM rag_document_versions v
         JOIN rag_documents d ON d.document_key = v.document_key
        WHERE v.document_key = $1
        ORDER BY v.version ASC`,
      [documentKey],
    );
    return result.rows.map(mapVersion);
  }

  async getActiveChunks(documentKey: string): Promise<StoredChunk[]> {
    const result = await this.pool.query<ChunkRow>(
      `SELECT ${CHUNK_COLUMNS}
         FROM rag_chunks c
         JOIN rag_documents d ON d.document_key = c.document_key
        WHERE c.document_key = $1 AND c.document_version = d.current_version
        ORDER BY c.chunk_index ASC`,
      [documentKey],
    );
    return result.rows.map(mapChunk);
  }

  async getChunks(documentKey: string, version: number): Promise<StoredChunk[]> {
    const result = await this.pool.query<ChunkRow>(
      `SELECT ${CHUNK_COLUMNS}
         FROM rag_chunks c
         JOIN rag_documents d ON d.document_key = c.document_key
        WHERE c.document_key = $1 AND c.document_version = $2
        ORDER BY c.chunk_index ASC`,
      [documentKey, version],
    );
    return result.rows.map(mapChunk);
  }

  async appendVersion(input: NewVersionInput): Promise<void> {
    const { version, chunks } = input;
    const documentKey = version.documentKey;

    // Same guard as the in-memory store: every chunk must belong to the version being appended.
    for (const chunk of chunks) {
      if (chunk.documentKey !== documentKey) {
        throw new RagStorageError(
          `Chunk documentKey "${chunk.documentKey}" does not match version documentKey "${documentKey}".`,
        );
      }
      if (chunk.documentVersion !== version.version) {
        throw new RagStorageError(
          `Chunk documentVersion ${String(chunk.documentVersion)} does not match version ${String(version.version)}.`,
        );
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the document row (if any) so concurrent appends to the same key are serialized and the
      // current-version read used for the contiguity check cannot race.
      const current = await client.query<{ current_version: number }>(
        "SELECT current_version FROM rag_documents WHERE document_key = $1 FOR UPDATE",
        [documentKey],
      );
      const existing = current.rows[0];

      if (existing === undefined) {
        if (version.version !== 1) {
          throw new RagStorageError(
            `First version for "${documentKey}" must be 1, received ${String(version.version)}.`,
          );
        }
        await client.query(
          "INSERT INTO rag_documents (document_key, current_version, created_at) VALUES ($1, $2, $3)",
          [documentKey, 1, version.createdAt],
        );
      } else {
        const expected = existing.current_version + 1;
        if (version.version !== expected) {
          throw new RagStorageError(
            `Next version for "${documentKey}" must be ${String(expected)}, received ${String(version.version)}.`,
          );
        }
      }

      await insertVersion(client, input);
      await insertChunks(client, input);

      if (existing !== undefined) {
        // Advance the mutable pointer only — old versions and chunks are left untouched.
        await client.query(
          "UPDATE rag_documents SET current_version = $2 WHERE document_key = $1",
          [documentKey, version.version],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertVersion(client: PoolClient, input: NewVersionInput): Promise<void> {
  const v = input.version;
  await client.query(
    `INSERT INTO rag_document_versions
       (document_key, version, source_url, title, document_type, language,
        content, content_hash, crawler_version, extractor_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      v.documentKey,
      v.version,
      v.sourceUrl,
      v.title,
      v.documentType,
      v.language,
      v.content,
      v.contentHash,
      v.crawlerVersion,
      v.extractorVersion,
      v.createdAt,
    ],
  );
}

async function insertChunks(client: PoolClient, input: NewVersionInput): Promise<void> {
  for (const chunk of input.chunks) {
    await client.query(
      `INSERT INTO rag_chunks
         (document_key, document_version, chunk_index, chunk_key, question, answer,
          content, content_hash, source_url, title, document_type, language,
          crawler_version, extractor_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        chunk.documentKey,
        chunk.documentVersion,
        chunk.chunkIndex,
        chunk.chunkKey,
        chunk.question,
        chunk.answer,
        chunk.content,
        chunk.contentHash,
        chunk.sourceUrl,
        chunk.title,
        chunk.documentType,
        chunk.language,
        chunk.crawlerVersion,
        chunk.extractorVersion,
        chunk.createdAt,
      ],
    );
  }
}

function mapVersion(row: VersionRow): StoredDocumentVersion {
  return Object.freeze({
    documentKey: row.document_key,
    version: row.version,
    sourceUrl: row.source_url,
    title: row.title,
    documentType: row.document_type,
    language: row.language,
    content: row.content,
    contentHash: row.content_hash,
    crawlerVersion: row.crawler_version,
    extractorVersion: row.extractor_version,
    createdAt: row.created_at.toISOString(),
    isActive: row.is_active,
  });
}

function mapChunk(row: ChunkRow): StoredChunk {
  return Object.freeze({
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkIndex: row.chunk_index,
    chunkKey: row.chunk_key,
    question: row.question,
    answer: row.answer,
    content: row.content,
    contentHash: row.content_hash,
    sourceUrl: row.source_url,
    title: row.title,
    documentType: row.document_type,
    language: row.language,
    crawlerVersion: row.crawler_version,
    extractorVersion: row.extractor_version,
    createdAt: row.created_at.toISOString(),
    isActive: row.is_active,
  });
}
