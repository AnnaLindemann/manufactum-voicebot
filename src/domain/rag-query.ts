/**
 * Internal domain model and public response contract for `POST /api/rag/query`.
 *
 * This is a **retrieval** contract, not an answer contract. The backend returns recorded FAQ
 * evidence and nothing else; formulating a spoken answer from that evidence belongs to the external
 * agent (Dialfire). See `api-contracts.md` § POST /api/rag/query.
 *
 * `toRagQueryResponse` is the single place where a retrieval result becomes a caller-visible object.
 * It is a pure, total, allow-list projection: it names every field that may leave the backend, so an
 * embedding vector, a canonical chunk `content`, a document type, an SQL fragment, or any field a
 * later retrieval change happens to add cannot reach a caller by accident.
 */

/** A validated request. Only this shape reaches the application service. */
export type RagQuery = {
  query: string;
};

/** Where one piece of evidence came from. Version included: RAG answers must be version-traceable. */
export type RagEvidenceSource = {
  documentKey: string;
  documentVersion: number;
  title: string;
  sourceUrl: string;
};

export type RagEvidence = {
  chunkKey: string;
  question: string;
  answer: string;
  /** Cosine similarity against the caller's question, rounded; see `RAG_EVIDENCE_SCORE_PRECISION`. */
  score: number;
  source: RagEvidenceSource;
};

/**
 * `not_found` means no chunk reached the configured minimum relevance. It is a complete, final
 * answer from the backend's side, never an invitation to fall back to a weaker match.
 */
export type RagQueryStatus = "found" | "not_found";

export type RagQueryResponse = {
  status: RagQueryStatus;
  /** The trimmed query the retrieval actually ran on, echoed so a caller can log what was searched. */
  query: string;
  /** Ordered most relevant first; empty exactly when `status` is `not_found`. */
  evidence: RagEvidence[];
};

/**
 * Scores are rounded to six decimals, matching the offline retrieval reports. Raw double output
 * varies in its last bits across platforms and pgvector builds, which would make an otherwise
 * deterministic response body compare unequal between environments.
 */
export const RAG_EVIDENCE_SCORE_PRECISION = 6;

/**
 * The retrieval fields this projection consumes. Declared structurally rather than imported from the
 * store, so the domain layer stays free of storage types and the allow-list is visible in one place.
 * `RelevantChunkSearchResult` satisfies it.
 */
export type RetrievedEvidenceChunk = {
  chunkKey: string;
  question: string;
  answer: string;
  score: number;
  documentKey: string;
  documentVersion: number;
  title: string;
  sourceUrl: string;
};

/**
 * Maps already-thresholded, already-ordered retrieval results onto the response contract.
 *
 * Order is preserved exactly as retrieval produced it — the mapper never re-ranks, re-sorts, or
 * drops a result, so the deterministic ordering of the retrieval query is the ordering a caller sees.
 */
export function toRagQueryResponse(
  query: string,
  chunks: readonly RetrievedEvidenceChunk[],
): RagQueryResponse {
  return {
    status: chunks.length > 0 ? "found" : "not_found",
    query,
    evidence: chunks.map((chunk) => ({
      chunkKey: chunk.chunkKey,
      question: chunk.question,
      answer: chunk.answer,
      score: roundScore(chunk.score),
      source: {
        documentKey: chunk.documentKey,
        documentVersion: chunk.documentVersion,
        title: chunk.title,
        sourceUrl: chunk.sourceUrl,
      },
    })),
  };
}

function roundScore(score: number): number {
  return Number(score.toFixed(RAG_EVIDENCE_SCORE_PRECISION));
}
