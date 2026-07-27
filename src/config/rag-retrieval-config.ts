import { z } from "zod";

/**
 * Runtime configuration for RAG retrieval behind `POST /api/rag/query`.
 *
 * Every value here is **operator** configuration, read from the environment at the first retrieval
 * call. None of it is ever accepted from an HTTP caller: an external agent such as Dialfire may send
 * a question and nothing else, so it cannot widen `maxChunks`, lower `minScore`, or point the search
 * at a different embedding profile or database. See `api-contracts.md` § POST /api/rag/query.
 *
 * Read lazily, like `loadManufactumConfig`, so importing the app for a health check or a test needs
 * no database and no model cache.
 */

/**
 * `[D]` The retrieval width already used by the offline retrieval path (`scripts/smoke-rag-retrieval.ts`,
 * `rag-embeddings-and-retrieval-design.md` §5: default `k = 3`, maximum `5`). It is a code constant, not
 * an environment variable: the accepted evaluation was measured at this width, and a value an operator
 * could change would silently invalidate that measurement.
 */
export const RAG_RETRIEVAL_MAX_CHUNKS = 3;

/**
 * `[D]` **Provisional and unchanged.** `0.8` is the value the existing retrieval path already applies
 * (`scripts/smoke-rag-retrieval.ts`, `.env.example`). It is carried over verbatim rather than chosen
 * here: `rag-retrieval-evaluation-checkpoint-report.md` selects no production threshold and records
 * `0.80` as too permissive for rejection on a single-source dataset, and no new calibration evidence
 * exists. Introducing a different number at the API boundary would be a threshold change dressed as an
 * integration step. It stays overridable through `RAG_RETRIEVAL_MIN_SCORE` for evaluation runs, and it
 * remains bound to the active embedding profile: a threshold calibrated for `multilingual-e5-small`
 * does not transfer to another model.
 */
export const DEFAULT_RAG_RETRIEVAL_MIN_SCORE = 0.8;

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  /** Bounded exactly as `retrieveRelevantChunks` bounds it, so a bad value fails at load, not mid-request. */
  maxChunks: z.number().int().min(1).max(5),
  minScore: z.number().min(0).max(1),
  embeddingLocalFilesOnly: z.boolean(),
  embeddingCacheDir: z.string().min(1).optional(),
});

export type RagRetrievalConfig = z.infer<typeof configSchema>;

/**
 * @throws {Error} when a variable is missing or malformed. The message names the variable only; a
 * connection string carries credentials and must never reach a log line or a caller.
 */
export function loadRagRetrievalConfig(env: NodeJS.ProcessEnv = process.env): RagRetrievalConfig {
  const rawMinScore = nonEmpty(env.RAG_RETRIEVAL_MIN_SCORE);
  const cacheDir = nonEmpty(env.TRANSFORMERS_CACHE);

  const result = configSchema.safeParse({
    databaseUrl: nonEmpty(env.DATABASE_URL),
    maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
    // An unset variable takes the documented default; a set-but-malformed one is a configuration
    // error and must fail loudly rather than silently fall back to a different threshold.
    minScore: rawMinScore === undefined ? DEFAULT_RAG_RETRIEVAL_MIN_SCORE : Number(rawMinScore),
    embeddingLocalFilesOnly: env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
    ...(cacheDir === undefined ? {} : { embeddingCacheDir: cacheDir }),
  });

  if (!result.success) {
    const variables: Record<string, string> = {
      databaseUrl: "DATABASE_URL",
      maxChunks: "RAG retrieval maxChunks (internal constant)",
      minScore: "RAG_RETRIEVAL_MIN_SCORE",
      embeddingLocalFilesOnly: "RAG_EMBEDDING_LOCAL_FILES_ONLY",
      embeddingCacheDir: "TRANSFORMERS_CACHE",
    };

    const missing = [
      ...new Set(
        result.error.issues.map((issue) => variables[String(issue.path[0])] ?? "unknown variable"),
      ),
    ];

    throw new Error(`Invalid or missing RAG retrieval configuration: ${missing.join(", ")}`);
  }

  return result.data;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
