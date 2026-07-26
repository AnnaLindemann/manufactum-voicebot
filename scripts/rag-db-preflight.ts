import "dotenv/config";
import pg from "pg";
import { embeddingProfileModelRef } from "../src/rag/embedding-profile.js";

type DocumentRow = {
  document_key: string;
  current_version: number;
};

type VersionRow = {
  document_key: string;
  version: number;
  active: boolean;
};

type StagedRow = {
  document_key: string;
  version: number;
};

type ActiveChunkRow = {
  document_key: string;
  document_version: number;
  chunk_index: number;
  chunk_key: string;
  question: string;
  source_url: string;
  title: string;
  document_type: string;
  language: string;
};

type EmbeddingCountRow = {
  total: number;
  dim384: number;
  valid_profile: number;
};

type ActiveEmbeddingCountRow = {
  active_valid_embeddings: number;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for the read-only RAG database preflight.");
  }

  const pool = new pg.Pool({ connectionString });
  const model = embeddingProfileModelRef();

  try {
    const [documents, versions, staged, activeChunks, embeddings, activeEmbeddings] =
      await Promise.all([
        pool.query<DocumentRow>(
          "SELECT document_key, current_version FROM rag_documents ORDER BY document_key",
        ),
        pool.query<VersionRow>(
          `SELECT v.document_key, v.version, (d.current_version = v.version) AS active
             FROM rag_document_versions v
             LEFT JOIN rag_documents d ON d.document_key = v.document_key
            ORDER BY v.document_key, v.version`,
        ),
        pool.query<StagedRow>(
          `SELECT v.document_key, v.version
             FROM rag_document_versions v
             LEFT JOIN rag_documents d ON d.document_key = v.document_key
            WHERE d.current_version IS NULL OR v.version > d.current_version
            ORDER BY v.document_key, v.version`,
        ),
        pool.query<ActiveChunkRow>(
          `SELECT c.document_key, c.document_version, c.chunk_index, c.chunk_key, c.question,
                  c.source_url, c.title, c.document_type, c.language
             FROM rag_chunks c
             JOIN rag_documents d
               ON d.document_key = c.document_key
              AND d.current_version = c.document_version
            ORDER BY c.document_key, c.document_version, c.chunk_index`,
        ),
        pool.query<EmbeddingCountRow>(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE vector_dims(embedding) = 384)::int AS dim384,
                  count(*) FILTER (
                    WHERE embedding_provider = $1
                      AND embedding_model = $2
                      AND embedding_model_version = $3
                      AND embedding_artifact = $4
                      AND embedding_dtype = $5
                      AND embedding_runtime = $6
                      AND embedding_profile_id = $7
                      AND embedding_dim = 384
                      AND input_recipe = 'e5:passage:v1'
                      AND normalized = true
                  )::int AS valid_profile
             FROM rag_chunk_embeddings`,
          [
            model.embeddingProvider,
            model.embeddingModel,
            model.embeddingModelVersion,
            model.embeddingArtifact,
            model.embeddingDtype,
            model.embeddingRuntime,
            model.embeddingProfileId,
          ],
        ),
        pool.query<ActiveEmbeddingCountRow>(
          `SELECT count(*)::int AS active_valid_embeddings
             FROM rag_chunk_embeddings e
             JOIN rag_documents d
               ON d.document_key = e.document_key
              AND d.current_version = e.document_version
            WHERE e.embedding_provider = $1
              AND e.embedding_model = $2
              AND e.embedding_model_version = $3
              AND e.embedding_artifact = $4
              AND e.embedding_dtype = $5
              AND e.embedding_runtime = $6
              AND e.embedding_profile_id = $7
              AND vector_dims(e.embedding) = 384`,
          [
            model.embeddingProvider,
            model.embeddingModel,
            model.embeddingModelVersion,
            model.embeddingArtifact,
            model.embeddingDtype,
            model.embeddingRuntime,
            model.embeddingProfileId,
          ],
        ),
      ]);

    console.log(
      JSON.stringify(
        {
          documents: documents.rows,
          versions: versions.rows,
          stagedOrPartiallyEmbeddedVersions: staged.rows,
          activeChunks: activeChunks.rows,
          embeddings: embeddings.rows[0],
          activeEmbeddings: activeEmbeddings.rows[0],
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

await main();
