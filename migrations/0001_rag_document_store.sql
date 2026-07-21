-- RAG document store: documents, immutable versions, immutable chunks (D-004, D-005).
--
-- Model:
--   * rag_documents holds one row per document key. Its only mutable field is current_version, the
--     pointer to the active version. Everything else about the active version (source URL, title,
--     content hash, ...) is derived by joining to the matching rag_document_versions row.
--   * rag_document_versions and rag_chunks are append-only and immutable: once a version and its
--     chunks are written they are never edited, only superseded by a newer version. "Active" is not a
--     stored flag; a version is active iff its number equals rag_documents.current_version.
--
-- New versions and their chunks are written in a single transaction that also advances
-- current_version, so a partially applied version can never be observed.

CREATE TABLE rag_documents (
  document_key    text        PRIMARY KEY,
  -- Mutable pointer to the active version. Advanced (only) when a changed document is ingested.
  current_version integer     NOT NULL CHECK (current_version >= 1),
  -- Creation time of version 1; the document's stable createdAt.
  created_at      timestamptz NOT NULL
);

CREATE TABLE rag_document_versions (
  document_key      text        NOT NULL REFERENCES rag_documents (document_key),
  version           integer     NOT NULL CHECK (version >= 1),
  source_url        text        NOT NULL,
  title             text        NOT NULL,
  document_type     text        NOT NULL,
  language          text        NOT NULL,
  content           text        NOT NULL,
  content_hash      text        NOT NULL,
  crawler_version   text        NOT NULL,
  extractor_version text        NOT NULL,
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (document_key, version)
);

CREATE TABLE rag_chunks (
  document_key      text        NOT NULL,
  document_version  integer     NOT NULL,
  chunk_index       integer     NOT NULL CHECK (chunk_index >= 1),
  -- Approved chunk-key format: {document_key}:v{document_version}:chunk-{zero-padded 1-based index}.
  chunk_key         text        NOT NULL UNIQUE,
  question          text        NOT NULL,
  answer            text        NOT NULL,
  content           text        NOT NULL,
  content_hash      text        NOT NULL,
  source_url        text        NOT NULL,
  title             text        NOT NULL,
  document_type     text        NOT NULL,
  language          text        NOT NULL,
  crawler_version   text        NOT NULL,
  extractor_version text        NOT NULL,
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (document_key, document_version, chunk_index),
  FOREIGN KEY (document_key, document_version)
    REFERENCES rag_document_versions (document_key, version)
);

-- Reading the active chunks of a document is a join on (document_key, current_version).
CREATE INDEX rag_chunks_document_version_idx
  ON rag_chunks (document_key, document_version, chunk_index);

-- Enforce immutability at the database level: stored versions and chunks may be inserted but never
-- updated or deleted. current_version lives on rag_documents, which stays freely updatable.
CREATE FUNCTION rag_forbid_mutation () RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rag_document_versions_immutable
  BEFORE UPDATE OR DELETE ON rag_document_versions
  FOR EACH ROW EXECUTE FUNCTION rag_forbid_mutation ();

CREATE TRIGGER rag_chunks_immutable
  BEFORE UPDATE OR DELETE ON rag_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_forbid_mutation ();
