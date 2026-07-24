export class RagRetrievalError extends Error {
  constructor(
    readonly code:
      | "RAG_RETRIEVAL_INVALID_CONFIGURATION"
      | "RAG_RETRIEVAL_INVALID_QUERY_VECTOR"
      | "RAG_RETRIEVAL_INVALID_SCORE"
      | "RAG_RETRIEVAL_STORE_FAILED",
    technicalMessage: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(technicalMessage, { cause });
    this.name = "RagRetrievalError";
  }
}
