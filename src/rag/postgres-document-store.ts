import type { Pool, PoolClient } from "pg";
import type {
  ChunkEmbeddingCore,
  EmbeddingModelRef,
  NewVersionInput,
  RagDocumentStore,
  RelevantChunkSearchOptions,
  RelevantChunkSearchResult,
  StoredChunk,
  StoredChunkEmbedding,
  StoredDocument,
  StoredDocumentVersion,
} from "./document-store.js";
import { RagStorageError } from "./in-memory-document-store.js";
import { RagRetrievalError } from "./retrieval-errors.js";

/**
 * PostgreSQL implementation of `RagDocumentStore` (`D-004`,
 * `rag-embeddings-and-retrieval-design.md` §4).
 *
 * Persists documents, immutable versions, immutable chunks, and immutable chunk embeddings in the
 * schema created by `migrations/`. It is a drop-in replacement for `InMemoryRagDocumentStore`: the
 * ingestion flow is unchanged and this store enforces the same versioning and lifecycle invariants.
 *
 * Immutability is structural. Old versions, chunks, and embeddings are never updated or deleted (the
 * migrations install triggers forbidding it); "active" is derived on read by comparing a version
 * number to `rag_documents.current_version`, never stored as a mutable flag.
 *
 * Lifecycle. A version is **staged** (its version and chunk rows are written, but the active pointer
 * is not advanced and, for a brand-new key, no `rag_documents` header is created yet). Its chunk
 * **embeddings** are stored append-only and idempotently. It is then **activated** under a per-document
 * lock, but only once every chunk carries an embedding for the active model (the readiness gate);
 * activation advances/creates the active pointer in a single transaction, so a partial version is
 * never observable and a document without embeddings is never active.
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

/** Shape of an embedding row. `embedding` is selected as its pgvector text form, e.g. `[0.1,0.2]`. */
type EmbeddingRow = {
  document_key: string;
  document_version: number;
  chunk_index: number;
  embedding_provider: string;
  embedding_model: string;
  embedding_model_version: string;
  embedding_artifact: string;
  embedding_dtype: string;
  embedding_runtime: string;
  embedding_profile_id: string;
  embedding_dim: number;
  input_recipe: string;
  normalized: boolean;
  input_hash: string;
  chunk_content_hash: string;
  embedding: string;
  created_at: Date;
};

type RetrievalRow = {
  content: string;
  question: string;
  answer: string;
  score: number | string;
  document_key: string;
  document_version: number;
  chunk_key: string;
  source_url: string;
  title: string;
  document_type: string;
  language: string;
};

/**
 * Columns selected for a version. `is_active` is `COALESCE(v.version = d.current_version, false)` so a
 * staged version with no document header yet (a brand-new key) correctly reads as inactive.
 */
const VERSION_COLUMNS = `
  v.document_key, v.version, v.source_url, v.title, v.document_type, v.language,
  v.content, v.content_hash, v.crawler_version, v.extractor_version, v.created_at,
  COALESCE(v.version = d.current_version, false) AS is_active
`;

/** Columns selected for a chunk, with `is_active` derived (and null-safe for staged new keys). */
const CHUNK_COLUMNS = `
  c.document_key, c.document_version, c.chunk_index, c.chunk_key, c.question, c.answer,
  c.content, c.content_hash, c.source_url, c.title, c.document_type, c.language,
  c.crawler_version, c.extractor_version, c.created_at,
  COALESCE(c.document_version = d.current_version, false) AS is_active
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
    // INNER JOIN: an active version requires a document header pointing at it.
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

  async getStagedVersion(documentKey: string): Promise<StoredDocumentVersion | undefined> {
    // A staged version is one whose number exceeds the active version (0 when no header exists). At
    // most one is pending, so LIMIT 1 on the highest version returns it.
    const result = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM rag_document_versions v
         LEFT JOIN rag_documents d ON d.document_key = v.document_key
        WHERE v.document_key = $1
          AND v.version > COALESCE(d.current_version, 0)
        ORDER BY v.version DESC
        LIMIT 1`,
      [documentKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapVersion(row);
  }

  async getVersion(
    documentKey: string,
    version: number,
  ): Promise<StoredDocumentVersion | undefined> {
    // LEFT JOIN so a staged version of a not-yet-activated new key is still returned.
    const result = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM rag_document_versions v
         LEFT JOIN rag_documents d ON d.document_key = v.document_key
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
         LEFT JOIN rag_documents d ON d.document_key = v.document_key
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
         LEFT JOIN rag_documents d ON d.document_key = c.document_key
        WHERE c.document_key = $1 AND c.document_version = $2
        ORDER BY c.chunk_index ASC`,
      [documentKey, version],
    );
    return result.rows.map(mapChunk);
  }

  async getChunkEmbeddings(documentKey: string, version: number): Promise<StoredChunkEmbedding[]> {
    const result = await this.pool.query<EmbeddingRow>(
      `SELECT document_key, document_version, chunk_index, embedding_provider, embedding_model,
              embedding_model_version, embedding_artifact, embedding_dtype, embedding_runtime,
              embedding_profile_id, embedding_dim, input_recipe, normalized, input_hash, chunk_content_hash,
              embedding::text AS embedding, created_at
         FROM rag_chunk_embeddings
        WHERE document_key = $1 AND document_version = $2
        ORDER BY chunk_index ASC, embedding_model ASC, embedding_model_version ASC, embedding_profile_id ASC`,
      [documentKey, version],
    );
    return result.rows.map(mapEmbedding);
  }

  async stageVersion(input: NewVersionInput): Promise<void> {
    const { version, chunks } = input;
    const documentKey = version.documentKey;

    // Same guard as the in-memory store: every chunk must belong to the version being staged.
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
      // Serialize staging/activation for this key. A brand-new key has a document row with a NULL
      // active pointer, so an advisory lock (not just SELECT ... FOR UPDATE) serializes concurrent
      // operations even before the first activation.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [documentKey]);

      const current = await client.query<{ current_version: number | null }>(
        "SELECT current_version FROM rag_documents WHERE document_key = $1",
        [documentKey],
      );
      const documentExists = current.rows.length > 0;
      // The active pointer may be NULL (a staged-but-never-activated new key).
      const active = current.rows[0]?.current_version ?? null;

      const maxRow = await client.query<{ max_version: number | null }>(
        "SELECT max(version) AS max_version FROM rag_document_versions WHERE document_key = $1",
        [documentKey],
      );
      const maxVersion = maxRow.rows[0]?.max_version ?? 0;

      // At most one staged version per document: a version above the active pointer blocks staging.
      if (maxVersion > (active ?? 0)) {
        throw new RagStorageError(
          `Document "${documentKey}" already has a pending staged version; activate it before staging another.`,
        );
      }

      const expected = (active ?? 0) + 1;
      if (version.version !== expected) {
        throw new RagStorageError(
          `Next version for "${documentKey}" must be ${String(expected)}, received ${String(version.version)}.`,
        );
      }

      if (!documentExists) {
        // Brand-new key: create the document header first, with the active pointer unset (NULL), so the
        // staged version's foreign key to rag_documents is satisfied. current_version is advanced at
        // activation. createdAt is stamped from version 1 (the document's stable createdAt).
        await client.query(
          "INSERT INTO rag_documents (document_key, current_version, created_at) VALUES ($1, NULL, $2)",
          [documentKey, version.createdAt],
        );
      }

      await insertVersion(client, input);
      await insertChunks(client, input);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveChunkEmbeddings(embeddings: ChunkEmbeddingCore[]): Promise<void> {
    // Validate declared dimension against vector length before touching the database (mirrors the
    // DB CHECK), so a mismatch is a clear RagStorageError rather than an opaque constraint violation.
    for (const embedding of embeddings) {
      if (embedding.embedding.length !== embedding.embeddingDim) {
        throw new RagStorageError(
          `Embedding dimension ${String(embedding.embeddingDim)} does not match vector length ${String(embedding.embedding.length)} for ${embedding.documentKey} v${String(embedding.documentVersion)} chunk ${String(embedding.chunkIndex)}.`,
        );
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const embedding of embeddings) {
        // Append-only. ON CONFLICT DO NOTHING makes an exact retry a no-op (DO UPDATE is impossible
        // here — the immutability trigger forbids UPDATE). rowCount tells us whether a row was written.
        const inserted = await client.query(
          `INSERT INTO rag_chunk_embeddings
             (document_key, document_version, chunk_index, embedding_provider, embedding_model,
              embedding_model_version, embedding_artifact, embedding_dtype, embedding_runtime,
              embedding_profile_id, embedding_dim, input_recipe, normalized, input_hash, chunk_content_hash,
              embedding, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::vector, $17)
           ON CONFLICT
             (document_key, document_version, chunk_index, embedding_provider, embedding_model,
              embedding_model_version, embedding_artifact, embedding_dtype, embedding_runtime,
              embedding_profile_id)
           DO NOTHING`,
          [
            embedding.documentKey,
            embedding.documentVersion,
            embedding.chunkIndex,
            embedding.embeddingProvider,
            embedding.embeddingModel,
            embedding.embeddingModelVersion,
            embedding.embeddingArtifact,
            embedding.embeddingDtype,
            embedding.embeddingRuntime,
            embedding.embeddingProfileId,
            embedding.embeddingDim,
            embedding.inputRecipe,
            embedding.normalized,
            embedding.inputHash,
            embedding.chunkContentHash,
            formatVector(embedding.embedding),
            embedding.createdAt,
          ],
        );

        if (inserted.rowCount === 0) {
          // A row already exists for this profile key. Idempotent no-op only if its content is
          // identical; a conflicting retry (same key, different vector/hashes/metadata) must fail
          // loudly instead of being silently swallowed. The vector is compared inside the database so
          // both sides are the same (float4) precision. created_at is excluded: it is a recording
          // timestamp, not embedding content, and a legitimate retry may carry a fresh one.
          const compared = await client.query<{ same: boolean }>(
            `SELECT (embedding = $11::vector
                     AND embedding_dim = $12
                     AND input_recipe = $13
                     AND normalized = $14
                     AND input_hash = $15
                     AND chunk_content_hash = $16) AS same
               FROM rag_chunk_embeddings
              WHERE document_key = $1 AND document_version = $2 AND chunk_index = $3
                AND embedding_provider = $4
                AND embedding_model = $5
                AND embedding_model_version = $6
                AND embedding_artifact = $7
                AND embedding_dtype = $8
                AND embedding_runtime = $9
                AND embedding_profile_id = $10`,
            [
              embedding.documentKey,
              embedding.documentVersion,
              embedding.chunkIndex,
              embedding.embeddingProvider,
              embedding.embeddingModel,
              embedding.embeddingModelVersion,
              embedding.embeddingArtifact,
              embedding.embeddingDtype,
              embedding.embeddingRuntime,
              embedding.embeddingProfileId,
              formatVector(embedding.embedding),
              embedding.embeddingDim,
              embedding.inputRecipe,
              embedding.normalized,
              embedding.inputHash,
              embedding.chunkContentHash,
            ],
          );
          if (compared.rows[0]?.same !== true) {
            throw new RagStorageError(
              `Conflicting embedding for existing key ${embedding.documentKey} v${String(embedding.documentVersion)} chunk ${String(embedding.chunkIndex)} (${embedding.embeddingModel}@${embedding.embeddingModelVersion}): a stored embedding with different content already exists and is immutable.`,
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activateVersion(
    documentKey: string,
    version: number,
    model: EmbeddingModelRef,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [documentKey]);

      const current = await client.query<{ current_version: number | null }>(
        "SELECT current_version FROM rag_documents WHERE document_key = $1 FOR UPDATE",
        [documentKey],
      );
      const active = current.rows[0]?.current_version ?? null;

      const staged = await client.query(
        "SELECT 1 FROM rag_document_versions WHERE document_key = $1 AND version = $2",
        [documentKey, version],
      );
      if (staged.rows.length === 0) {
        throw new RagStorageError(
          `Cannot activate version ${String(version)} of "${documentKey}": it is not staged.`,
        );
      }

      const expected = (active ?? 0) + 1;
      if (version !== expected) {
        throw new RagStorageError(
          `Next activatable version for "${documentKey}" is ${String(expected)}, received ${String(version)}.`,
        );
      }

      // Embedding readiness gate (design §4-C): refuse activation while any chunk of the target
      // version lacks an embedding for the active model.
      const gate = await client.query<{ missing: number }>(
        `SELECT count(*)::int AS missing
           FROM rag_chunks c
          WHERE c.document_key = $1
            AND c.document_version = $2
            AND NOT EXISTS (
              SELECT 1 FROM rag_chunk_embeddings e
               WHERE e.document_key = c.document_key
                 AND e.document_version = c.document_version
                 AND e.chunk_index = c.chunk_index
                 AND e.embedding_provider = $3
                 AND e.embedding_model = $4
                 AND e.embedding_model_version = $5
                 AND e.embedding_artifact = $6
                 AND e.embedding_dtype = $7
                 AND e.embedding_runtime = $8
                 AND e.embedding_profile_id = $9
            )`,
        [
          documentKey,
          version,
          model.embeddingProvider,
          model.embeddingModel,
          model.embeddingModelVersion,
          model.embeddingArtifact,
          model.embeddingDtype,
          model.embeddingRuntime,
          model.embeddingProfileId,
        ],
      );
      const missing = gate.rows[0]?.missing ?? 0;
      if (missing > 0) {
        throw new RagStorageError(
          `Cannot activate version ${String(version)} of "${documentKey}": ${String(missing)} chunk(s) lack an embedding for ${model.embeddingModel}@${model.embeddingModelVersion}.`,
        );
      }

      // The document header always exists after staging (staging creates it with a NULL pointer for a
      // new key), so activation only advances the mutable pointer. Old versions, chunks, and embeddings
      // are left untouched. `active` is NULL for the first activation of a new key.
      await client.query("UPDATE rag_documents SET current_version = $2 WHERE document_key = $1", [
        documentKey,
        version,
      ]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async searchRelevantChunks(
    options: RelevantChunkSearchOptions,
  ): Promise<RelevantChunkSearchResult[]> {
    try {
      const result = await this.pool.query<RetrievalRow>(
        `SELECT c.content,
                c.question,
                c.answer,
                1 - (e.embedding <=> $1::vector) AS score,
                c.document_key,
                c.document_version,
                c.chunk_key,
                c.source_url,
                c.title,
                c.document_type,
                c.language
           FROM rag_chunk_embeddings e
           JOIN rag_documents d
             ON d.document_key = e.document_key
            AND d.current_version = e.document_version
           JOIN rag_chunks c
             ON c.document_key = e.document_key
            AND c.document_version = e.document_version
            AND c.chunk_index = e.chunk_index
          WHERE e.embedding_provider = $2
            AND e.embedding_model = $3
            AND e.embedding_model_version = $4
            AND e.embedding_artifact = $5
            AND e.embedding_dtype = $6
            AND e.embedding_runtime = $7
            AND e.embedding_profile_id = $8
          ORDER BY score DESC, c.document_key ASC, c.document_version ASC, c.chunk_key ASC
          LIMIT $9`,
        [
          formatVector(options.queryEmbedding),
          options.model.embeddingProvider,
          options.model.embeddingModel,
          options.model.embeddingModelVersion,
          options.model.embeddingArtifact,
          options.model.embeddingDtype,
          options.model.embeddingRuntime,
          options.model.embeddingProfileId,
          options.maxChunks,
        ],
      );
      return result.rows.map(mapRetrievalRow);
    } catch (error) {
      if (error instanceof RagRetrievalError) {
        throw error;
      }
      throw new RagRetrievalError(
        "RAG_RETRIEVAL_STORE_FAILED",
        "RAG retrieval storage query failed.",
        true,
        error,
      );
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

/** pgvector text literal for a vector, e.g. `[0.1,0.2,0.3]`. Bound to a `$n::vector` placeholder. */
function formatVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Parse a pgvector text literal (`[0.1,0.2]`) back into a number array. */
function parseVector(text: string): number[] {
  const inner = text.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(",").map((part) => Number(part));
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

function mapEmbedding(row: EmbeddingRow): StoredChunkEmbedding {
  return Object.freeze({
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkIndex: row.chunk_index,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingModelVersion: row.embedding_model_version,
    embeddingArtifact: row.embedding_artifact,
    embeddingDtype: row.embedding_dtype,
    embeddingRuntime: row.embedding_runtime,
    embeddingProfileId: row.embedding_profile_id,
    embeddingDim: row.embedding_dim,
    inputRecipe: row.input_recipe,
    normalized: row.normalized,
    inputHash: row.input_hash,
    chunkContentHash: row.chunk_content_hash,
    embedding: parseVector(row.embedding),
    createdAt: row.created_at.toISOString(),
  });
}

function mapRetrievalRow(row: RetrievalRow): RelevantChunkSearchResult {
  const score = Number(row.score);
  if (!Number.isFinite(score) || score < -1.0001 || score > 1.0001) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_SCORE",
      `RAG retrieval returned an invalid cosine similarity for ${row.document_key} ${row.chunk_key}.`,
      false,
    );
  }
  return Object.freeze({
    content: row.content,
    question: row.question,
    answer: row.answer,
    score,
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkKey: row.chunk_key,
    sourceUrl: row.source_url,
    title: row.title,
    documentType: row.document_type,
    language: row.language,
  });
}
