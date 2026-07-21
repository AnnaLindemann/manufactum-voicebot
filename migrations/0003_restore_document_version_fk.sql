-- Restore the versions -> documents foreign key; allow a document to exist before its first active
-- version (rag-embeddings-and-retrieval-design.md §4-A; acceptance review of the staged-embeddings phase).
--
-- 0002 dropped rag_document_versions -> rag_documents so a brand-new key could stage v1 before any
-- rag_documents header existed. That was rejected in review: a staged version must still belong to an
-- existing document (no orphan versions). Instead the header is created first, with a NULLABLE active
-- pointer set to NULL (no active version yet), and v1 is staged under the intact foreign key; the
-- pointer is advanced to the version number at activation.
--
-- Forward-only: 0002 is left as applied. This migration reverses its FK drop and relaxes the NOT NULL,
-- bringing every database (fresh or already on 0002) to the corrected schema via `npm run migrate`.

-- The active pointer is NULL while a brand-new document has only a staged, not-yet-active version.
-- CHECK (current_version >= 1) from 0001 still holds for every non-null value (a CHECK passes on NULL).
ALTER TABLE rag_documents
  ALTER COLUMN current_version DROP NOT NULL;

-- Every document version must reference an existing document row: no orphan versions. Re-added under
-- the same constraint name 0001 used, after 0002 removed it.
ALTER TABLE rag_document_versions
  ADD CONSTRAINT rag_document_versions_document_key_fkey
  FOREIGN KEY (document_key) REFERENCES rag_documents (document_key);
