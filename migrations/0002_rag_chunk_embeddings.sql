-- Immutable chunk embeddings and staged-version support (rag-embeddings-and-retrieval-design.md §2, §4).
--
-- Forward-only migration. It does not rewrite 0001; it extends the schema:
--   1. enables pgvector;
--   2. allows a version to be staged for a brand-new key before its rag_documents header exists;
--   3. adds the append-only, immutable rag_chunk_embeddings table.
--
-- The optional HNSW ANN index from the design §5 is deliberately NOT created here: the baseline is
-- exact cosine retrieval, and an ANN index is added later only if a benchmark on the real corpus
-- shows it is needed.

CREATE EXTENSION IF NOT EXISTS vector;

-- Staging a version for a new key (design §4-A) writes rag_document_versions rows *before* any
-- rag_documents header exists, so the version -> document foreign key from 0001 must be relaxed. The
-- header is created only at activation (design §4-C). Immutability of versions/chunks is unaffected;
-- it is enforced by the triggers from 0001, not by this reference.
ALTER TABLE rag_document_versions
  DROP CONSTRAINT IF EXISTS rag_document_versions_document_key_fkey;

-- One immutable embedding per (chunk x model x model version). Re-embedding with a new model or model
-- version adds rows next to the old ones; it never overwrites. Bound to exactly one immutable chunk of
-- one document version via the foreign key, so an embedding cannot exist without its chunk.
CREATE TABLE rag_chunk_embeddings (
  -- Chunk identity: references the immutable chunk of a specific document version.
  document_key            text        NOT NULL,
  document_version        integer     NOT NULL,
  chunk_index             integer     NOT NULL,

  -- Embedding identity: which model and recipe produced the vector.
  embedding_model         text        NOT NULL,   -- e.g. 'intfloat/multilingual-e5-large'
  embedding_model_version text        NOT NULL,   -- pinned weight revision / ONNX artifact hash
  embedding_dim           integer     NOT NULL CHECK (embedding_dim > 0),
  input_recipe            text        NOT NULL,    -- e.g. 'e5:passage:v1' (text assembly + prefix)
  normalized              boolean     NOT NULL,    -- whether L2 normalization was applied

  -- Traceability of the exact input and its link to the chunk content.
  input_hash              text        NOT NULL,    -- SHA-256 of the exact string fed to the model
  chunk_content_hash      text        NOT NULL,    -- copy of rag_chunks.content_hash at embedding time

  -- The vector and its creation time. Type `vector` WITHOUT a fixed dimension: the column accepts
  -- vectors of different lengths from different models. The CHECK ties the actual vector length to the
  -- declared embedding_dim, so a row cannot lie about its dimension.
  embedding               vector      NOT NULL,
  created_at              timestamptz NOT NULL,

  CHECK (vector_dims(embedding) = embedding_dim),

  -- One vector per (chunk x model x model version): re-embedding adds rows, never rewrites.
  PRIMARY KEY (document_key, document_version, chunk_index, embedding_model, embedding_model_version),

  FOREIGN KEY (document_key, document_version, chunk_index)
    REFERENCES rag_chunks (document_key, document_version, chunk_index)
);

-- The activation readiness gate and (later) retrieval filter by (chunk, model, model version); this
-- index supports the "does every active chunk have an embedding for the active model" lookups.
CREATE INDEX rag_chunk_embeddings_model_idx
  ON rag_chunk_embeddings (embedding_model, embedding_model_version, document_key, document_version);

-- Same database-level immutability as versions/chunks: rows may be inserted but never updated or
-- deleted. Reuses the rag_forbid_mutation() function installed by 0001.
CREATE TRIGGER rag_chunk_embeddings_immutable
  BEFORE UPDATE OR DELETE ON rag_chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION rag_forbid_mutation ();
