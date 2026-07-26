# RAG Retrieval Evaluation Checkpoint Report

## Scope

Retrieval-evaluation checkpoint only. No HTTP route, answer generation, Dialfire change, production
threshold change, source ingestion, retrieval implementation change, or active RAG data mutation was
performed.

## Dataset Integrity

- Frozen dataset: `tests/fixtures/rag/retrieval-evaluation-dataset.json`.
- Dataset SHA-256: `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- Composition: `12` exact, `24` paraphrase, `8` hard-negative, `8` irrelevant; total `52`.
- The dataset file was not edited in this correction.
- The evaluator reads, hashes, parses, validates, and freezes the dataset before creating the model
  generator or running any retrieval/model scoring.
- The evaluator compares the frozen dataset before/after scoring and re-reads the dataset file after
  scoring to verify the SHA-256 did not change.

Durable full result artifact:

- `docs/evaluation/rag-retrieval-evaluation-results.json`

The artifact contains every query's top-1/top-2/top-3 chunk keys and scores, the complete answerability
threshold sweep from `0.50` to `0.95`, and the complete end-to-end outcome sweep. It contains no
credentials, database connection strings, or environment-specific absolute paths.

## Push And Repository Baseline

- Accepted commit already published: `1fcb312b049d410fe4dae04be5aa03a4cd1ca057`.
- Remote `origin/main` was verified at the accepted hash in the previous checkpoint work.
- Working tree before this correction contained only uncommitted evaluation artifacts plus untracked
  `dialfire/`.
- `dialfire/` remained untouched.

## Database Integrity

The working PostgreSQL database was inspected with `SELECT` queries only before and after this
correction.

- Documents: exactly one, `mein-konto`.
- `mein-konto.current_version`: `1`.
- Versions: exactly one, version `1`, active.
- Active chunks: `12`.
- Embeddings: `12` total, all `384` dimensions.
- Valid active profile embeddings: `12`.
- Other `document_key` values: none.
- Staged or partially embedded versions: none.

## Retrieval Architecture

- Internal service: `retrieveRelevantChunks` in `src/rag/retrieve-relevant-chunks.ts`.
- Store primitive: `PostgresRagDocumentStore.searchRelevantChunks`.
- Query embedding path: `TransformersE5SmallPassageEmbeddingGenerator.embedQuery`.
- Query prefix: `query: `; stored FAQ passage embeddings use `passage: `.
- Pinned profile: `Xenova/multilingual-e5-small`,
  revision `ae61bf0193ce3851dc8a45147e459b04ed783d8a`, `onnx/model_quantized.onnx`,
  `int8-quantized`, `@xenova/transformers@2.17.2`, dimension `384`.
- Cosine similarity: exact pgvector search, `1 - (e.embedding <=> $1::vector)`.
- Active-version filtering: join `rag_documents.current_version = e.document_version`.
- Profile filtering: full provider/model/revision/artifact/dtype/runtime/profile-id match.
- Top-k: `3`, ordered by score descending with deterministic chunk-key tie breaks.

## Corrected Methodology

The prior report incorrectly presented an end-to-end error accounting as a binary confusion matrix,
causing counts to sum to `57` instead of `52`. This correction separates three layers.

Ranking quality covers only the `36` answerable exact/paraphrase queries. For each threshold it reports
mutually exclusive `correctAccepted`, `wrongAccepted`, and `abstained`.

Binary answerability quality covers all `52` queries. Exact/paraphrase queries are answerable;
hard-negative/irrelevant queries are unanswerable. The confusion matrix is standard and mutually
exclusive:

- TP: answerable and score >= threshold.
- FN: answerable and score < threshold.
- FP: unanswerable and score >= threshold.
- TN: unanswerable and score < threshold.

End-to-end outcome accounting covers all `52` queries with five mutually exclusive buckets:
`correctAnswer`, `wrongChunkAcceptedForAnswerable`, `answerableRejected`,
`unanswerableIncorrectlyAccepted`, `unanswerableCorrectlyRejected`. This table is not a binary
confusion matrix.

## Ranking Metrics

Answerable queries: `36`.

- Top-1 accuracy: `0.861111`.
- Recall@3: `0.916667`.
- MRR: `0.888889`.
- Expected chunk rank distribution: rank 1 = `31`, rank 2 = `2`, rank 3 = `0`, absent from top 3 = `3`.
- Top-1/top-2 margin distribution: min `0.000153`, p25 `0.008349`, median `0.021036`, p75 `0.037350`,
  max `0.098715`.

At threshold `0.80` for answerable queries:

- `correctAccepted`: `31`.
- `wrongAccepted`: `5`.
- `abstained`: `0`.
- Sum: `36`.

Failures where the expected chunk was absent from top 3:

- `para-003-a`: expected `mein-konto:v1:chunk-003`; top-1 `mein-konto:v1:chunk-001`, score
  `0.883672`, margin `0.000576`.
- `para-006-a`: expected `mein-konto:v1:chunk-006`; top-1 `mein-konto:v1:chunk-001`, score
  `0.884550`, margin `0.021398`.
- `para-012-b`: expected `mein-konto:v1:chunk-012`; top-1 `mein-konto:v1:chunk-001`, score
  `0.881850`, margin `0.000153`.

## Answerability Metrics

Corrected binary answerability at threshold `0.80`:

- TP: `36`.
- FN: `0`.
- FP: `9` (`8` hard negatives, `1` irrelevant).
- TN: `7`.
- Sum: `52`.
- Precision: `0.800000`.
- Recall: `1.000000`.
- F1: `0.888889`.
- Specificity: `0.437500`.
- False-positive rate: `0.562500`.
- Accuracy: `0.826923`.

## End-To-End Outcomes

Threshold `0.80`:

- Correct answer: `31`.
- Wrong chunk accepted for an answerable query: `5`.
- Answerable query rejected: `0`.
- Unanswerable query incorrectly accepted: `9`.
- Unanswerable query correctly rejected: `7`.
- Sum: `52`.

These values match the requested checkpoint expectations.

## Threshold Sweep

The full sweep from `0.50` through `0.95` in `0.01` increments is in
`docs/evaluation/rag-retrieval-evaluation-results.json`.

Answerability sweep highlights:

| Threshold |  TP |  FN |  FP |  TN | Hard Neg FP | Irrelevant FP | Precision |   Recall |       F1 | Specificity |      FPR | Accuracy |
| --------: | --: | --: | --: | --: | ----------: | ------------: | --------: | -------: | -------: | ----------: | -------: | -------: |
|      0.80 |  36 |   0 |   9 |   7 |           8 |             1 |  0.800000 | 1.000000 | 0.888889 |    0.437500 | 0.562500 | 0.826923 |
|      0.85 |  36 |   0 |   4 |  12 |           4 |             0 |  0.900000 | 1.000000 | 0.947368 |    0.750000 | 0.250000 | 0.923077 |
|      0.86 |  34 |   2 |   2 |  14 |           2 |             0 |  0.944444 | 0.944444 | 0.944444 |    0.875000 | 0.125000 | 0.923077 |
|      0.89 |  21 |  15 |   0 |  16 |           0 |             0 |  1.000000 | 0.583333 | 0.736842 |    1.000000 | 0.000000 | 0.711538 |
|      0.90 |  21 |  15 |   0 |  16 |           0 |             0 |  1.000000 | 0.583333 | 0.736842 |    1.000000 | 0.000000 | 0.711538 |
|      0.91 |  15 |  21 |   0 |  16 |           0 |             0 |  1.000000 | 0.416667 | 0.588236 |    1.000000 | 0.000000 | 0.596154 |
|      0.95 |   0 |  36 |   0 |  16 |           0 |             0 |  0.000000 | 0.000000 | 0.000000 |    1.000000 | 0.000000 | 0.307692 |

Best F1 in this run is answerability F1, not end-to-end correctness: threshold `0.85`,
`F1=0.947368`. This is only a labeled-set observation, not a production-threshold recommendation.

End-to-end outcome highlights:

| Threshold | Correct Answer | Wrong Answerable Accepted | Answerable Rejected | Unanswerable Accepted | Unanswerable Rejected | Total |
| --------: | -------------: | ------------------------: | ------------------: | --------------------: | --------------------: | ----: |
|      0.80 |             31 |                         5 |                   0 |                     9 |                     7 |    52 |
|      0.85 |             31 |                         5 |                   0 |                     4 |                    12 |    52 |
|      0.86 |             29 |                         5 |                   2 |                     2 |                    14 |    52 |
|      0.89 |             19 |                         2 |                  15 |                     0 |                    16 |    52 |
|      0.90 |             19 |                         2 |                  15 |                     0 |                    16 |    52 |
|      0.91 |             15 |                         0 |                  21 |                     0 |                    16 |    52 |
|      0.95 |              0 |                         0 |                  36 |                     0 |                    16 |    52 |

## Representative Failures

Wrong accepted answerable queries at threshold `0.80`:

- `para-003-a`: expected customer-number chunk `003`, top-1 was registration chunk `001`, score
  `0.883672`.
- `para-006-a`: expected forgotten-password chunk `006`, top-1 was registration chunk `001`, score
  `0.884550`.
- `para-009-b`: expected shared-wishlist chunk `009`, top-1 was wishlist-sharing chunk `008`, score
  `0.905599`; expected chunk rank `2`.
- `para-010-b`: expected newsletter-subscribe chunk `010`, top-1 was newsletter-unsubscribe chunk
  `011`, score `0.900095`; expected chunk rank `2`.
- `para-012-b`: expected account-deletion chunk `012`, top-1 was registration chunk `001`, score
  `0.881850`.

Unanswerable false accepts at threshold `0.80`:

- All `8` hard negatives were accepted; top-1 scores ranged from `0.830356` to `0.871006`.
- One irrelevant query was accepted: `irrelevant-004`, reservation in a store, score `0.845910`.

## Interpretation

Ranking quality is strong for exact questions and mixed for paraphrases. The rank distribution
(`31` rank-1, `2` rank-2, `3` absent from top 3) shows that most answerable queries retrieve the right
chunk first, but several account-adjacent paraphrases are not safely ranked.

Binary answerability at `0.80` has perfect recall on this dataset but weak rejection: `9/16`
unanswerable queries are accepted. Raising the threshold improves answerability precision in this
single-source dataset, but it also starts rejecting answerable queries above `0.85`.

No production threshold is selected. One FAQ source and 52 hand-labeled queries are not sufficient for a
production cutoff. The next calibration should use multiple approved sources, more hard negatives, and
possibly a margin or answerability gate rather than score threshold alone.

## Commands And Results

- `sha256sum tests/fixtures/rag/retrieval-evaluation-dataset.json` ->
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- `npx --yes tsx scripts/evaluate-rag-retrieval.ts --output docs/evaluation/rag-retrieval-evaluation-results.json`
  -> passed; threshold `0.80` assertions matched expected corrected values.
- `npx --yes tsx scripts/rag-db-preflight.ts` -> read-only DB preflight passed before and after
  evaluation correction.
- `npm run typecheck` -> passed.
- `npm run lint` -> passed.
- `npm run format:check` -> passed.
- `npm test` -> passed, `23` files and `377` tests.
- `npm run build` -> passed.
- `./node_modules/.bin/vitest run tests/integration/rag-postgres-document-store.test.ts --testTimeout 15000`
  -> passed, `1` file and `16` tests, against guarded disposable database `manufactum_rag_test`.
- `git diff --check` -> passed.

Final git status:

```text
?? dialfire/
?? docs/evaluation/
?? docs/rag-retrieval-evaluation-checkpoint-report.md
?? scripts/evaluate-rag-retrieval.ts
?? scripts/rag-db-preflight.ts
?? tests/fixtures/rag/retrieval-evaluation-dataset.json
```

## Files Changed

- `scripts/evaluate-rag-retrieval.ts` — corrected metrics, dataset immutability checks, durable
  `--output` support.
- `docs/evaluation/rag-retrieval-evaluation-results.json` — durable machine-readable evaluation
  artifact.
- `docs/rag-retrieval-evaluation-checkpoint-report.md` — corrected checkpoint report.

Unchanged:

- `tests/fixtures/rag/retrieval-evaluation-dataset.json`.
- Production threshold/configuration.
- Retrieval implementation.
- API routes, Dialfire, source ingestion, and active RAG database data.

## Recommendation

Keep the production threshold unchanged. Treat `0.80` as provisional and too permissive for rejection
on this dataset. Do not expose retrieval as an answering surface until calibration includes more sources
and more unanswerable account-adjacent questions.
