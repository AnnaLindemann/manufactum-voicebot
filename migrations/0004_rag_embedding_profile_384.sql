-- Local Render test embedding profile: Xenova/multilingual-e5-small, quantized ONNX, 384 dimensions.
--
-- Forward-only migration. It intentionally refuses to rewrite, truncate, or mix already-persisted
-- embeddings. If any rows exist, the migration stops with a clear error; operators must decide how
-- to retire those immutable rows before changing the active profile.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rag_chunk_embeddings LIMIT 1) THEN
    RAISE EXCEPTION
      'Cannot migrate rag_chunk_embeddings to vector(384): existing embedding rows are immutable and must not be converted, truncated, deleted, or mixed with the new 384-dimensional profile.';
  END IF;
END
$$;

ALTER TABLE rag_chunk_embeddings
  ADD COLUMN embedding_provider text NOT NULL DEFAULT 'local-transformers-js',
  ADD COLUMN embedding_artifact text NOT NULL DEFAULT 'onnx/model_quantized.onnx',
  ADD COLUMN embedding_dtype text NOT NULL DEFAULT 'int8-quantized',
  ADD COLUMN embedding_runtime text NOT NULL DEFAULT '@xenova/transformers@2.17.2',
  ADD COLUMN embedding_profile_id text NOT NULL DEFAULT 'local-transformers-js:xenova-multilingual-e5-small:ae61bf0193ce3851dc8a45147e459b04ed783d8a:onnx-model-quantized:int8:v1';

ALTER TABLE rag_chunk_embeddings
  ALTER COLUMN embedding TYPE vector(384),
  ADD CONSTRAINT rag_chunk_embeddings_embedding_dim_384_check CHECK (embedding_dim = 384);

ALTER TABLE rag_chunk_embeddings
  ALTER COLUMN embedding_provider DROP DEFAULT,
  ALTER COLUMN embedding_artifact DROP DEFAULT,
  ALTER COLUMN embedding_dtype DROP DEFAULT,
  ALTER COLUMN embedding_runtime DROP DEFAULT,
  ALTER COLUMN embedding_profile_id DROP DEFAULT;

ALTER TABLE rag_chunk_embeddings
  DROP CONSTRAINT rag_chunk_embeddings_pkey,
  ADD PRIMARY KEY (
    document_key,
    document_version,
    chunk_index,
    embedding_provider,
    embedding_model,
    embedding_model_version,
    embedding_artifact,
    embedding_dtype,
    embedding_runtime,
    embedding_profile_id
  );

CREATE INDEX rag_chunk_embeddings_profile_idx
  ON rag_chunk_embeddings (
    embedding_provider,
    embedding_model,
    embedding_model_version,
    embedding_artifact,
    embedding_dtype,
    embedding_runtime,
    embedding_profile_id,
    document_key,
    document_version
  );
