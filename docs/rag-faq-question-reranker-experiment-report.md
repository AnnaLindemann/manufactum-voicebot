# RAG FAQ-Question Reranker Experiment Report

## Scope

Controlled offline ranking experiment only. No production retrieval behavior, thresholds, routes,
ingestion, stored embeddings, chunks, active RAG data, answer generation, or Dialfire assets were
changed.

Durable result artifact:

- `docs/evaluation/rag-faq-question-reranker-experiment-results.json`

Preserved artifacts:

- `docs/evaluation/rag-retrieval-evaluation-results.json`
- `docs/evaluation/rag-brand-token-normalization-experiment-results.json`
- `docs/evaluation/rag-faq-question-gate-experiment-results.json`

The rejected FAQ question-match gate was not implemented in production. This experiment does not gate
answers and does not attempt to reduce false accepts.

## Baseline Verification

- Branch: `main`.
- `HEAD`: `3afcc4d902fa613f02756e08a52f61a893c2f157`.
- `origin/main`: `3afcc4d902fa613f02756e08a52f61a893c2f157`.
- Initial working tree had no tracked changes and only untracked `dialfire/`.
- Frozen dataset SHA-256:
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.

## Method

The evaluator first runs the existing baseline retrieval unchanged with `maxChunks=3`. It then reranks
only those three baseline candidates.

For every candidate:

- only the canonical FAQ question is extracted from `Frage:` before `Antwort:`;
- the original user query is embedded with the existing E5 query recipe and `query:` prefix;
- the canonical FAQ question is embedded with the existing E5 passage recipe and `passage:` prefix;
- normalized cosine similarity is used as the FAQ-question score;
- highest FAQ-question score wins;
- exact ties preserve the better original baseline rank.

No additional chunks are retrieved. Brand-token normalization is not used. Expected chunk IDs, labels,
and query categories are not used in the ranking decision. Retrieval scores and FAQ-question scores are
not combined.

Accept/reject decisions remain based on the original baseline Top-1 retrieval score. The reranked
candidate score is not used as a threshold, so answerability decisions and false-accept/correct-reject
counts are unchanged by construction.

## Recoverability

All five original wrong-Top-1 answerable query IDs:

- `para-003-a`
- `para-006-a`
- `para-009-b`
- `para-010-b`
- `para-012-b`

Recoverable from the original baseline Top-3:

- `para-009-b`
- `para-010-b`

Unrecoverable from the original baseline Top-3:

- `para-003-a`
- `para-006-a`
- `para-012-b`

## Changed Rankings

Answerable queries whose Top-1 ranking changed:

| Query ID     | Expected    | Baseline Top-1 | Candidate Top-1 | Outcome                  |
| ------------ | ----------- | -------------- | --------------- | ------------------------ |
| `para-003-a` | `chunk-003` | `chunk-001`    | `chunk-010`     | wrong-to-different-wrong |
| `para-006-a` | `chunk-006` | `chunk-001`    | `chunk-011`     | wrong-to-different-wrong |
| `para-007-a` | `chunk-007` | `chunk-007`    | `chunk-008`     | regression               |
| `para-007-b` | `chunk-007` | `chunk-007`    | `chunk-008`     | regression               |
| `para-009-b` | `chunk-009` | `chunk-008`    | `chunk-009`     | corrected                |
| `para-010-b` | `chunk-010` | `chunk-011`    | `chunk-010`     | corrected                |
| `para-012-b` | `chunk-012` | `chunk-001`    | `chunk-011`     | wrong-to-different-wrong |

The JSON artifact contains the original retrieval score and FAQ-question score for every Top-3
candidate in each changed case.

Corrected cases:

- `para-009-b`
- `para-010-b`

Regressed cases:

- `para-007-a`
- `para-007-b`

Wrong-to-different-wrong changes:

- `para-003-a`
- `para-006-a`
- `para-012-b`

## Metrics

| Metric         |   Baseline |  Candidate |
| -------------- | ---------: | ---------: |
| Top-1 accuracy | `0.861111` | `0.861111` |
| Recall@3       | `0.916667` | `0.916667` |
| MRR            | `0.888889` | `0.888889` |

Answerability at threshold `0.80` is unchanged:

- TP `36`, FN `0`, FP `9`, TN `7`.
- Hard-negative false accepts: `8`.
- Irrelevant false accepts: `1`.
- Correct rejects: `7`.

End-to-end accept/reject decisions are unchanged by construction. Ranking correctness changes are
reported separately and are not used as an answerability-threshold change.

## Decision

Candidate rejected.

It corrects both recoverable wrong-Top-1 answerable queries, preserves accept/reject decisions, keeps
Recall@3 unchanged, and is deterministic. It fails the fixed decision rule because it causes two
regressions among the 31 baseline-correct Top-1 answerable queries:

- `para-007-a`
- `para-007-b`

A ranking-only candidate with any baseline-correct Top-1 regression is not acceptable under the stated
decision rule.

## Verification

- Controlled reranker experiment rerun:
  `npx --yes tsx scripts/evaluate-rag-retrieval.ts --experiment faq-question-reranker --output docs/evaluation/rag-faq-question-reranker-experiment-results.json`
  -> passed.
- Frozen dataset hash verification:
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- Byte-for-byte integrity checks for the existing baseline, brand-token, and FAQ-question gate JSON
  artifacts -> passed; `git diff --` on those files was empty.
- Preserved artifact SHA-256 values:
  - `docs/evaluation/rag-retrieval-evaluation-results.json`:
    `585ea2f125fcf4aa3e3415506cbce957ff436b851854477b1cc8b15af7124aa1`.
  - `docs/evaluation/rag-brand-token-normalization-experiment-results.json`:
    `c6f0bdbcc012374ce4f47a9cc1939d6deb8249eda419401e4497a20d3fef52d8`.
  - `docs/evaluation/rag-faq-question-gate-experiment-results.json`:
    `85d44819bd4d37f707b8f048f646a00e90e586cef944e7c8abf7d9e2976aef69`.
- New artifact SHA-256 after deterministic generation and Prettier formatting:
  `c05f08bc7f7a94399cb975eb5cf0aff140f30ce854b0d6f49dc4290e86e2b9bc`.
- `npm run typecheck` -> passed.
- `npm run lint` -> passed.
- `npm run format:check` -> passed.
- `npm test` -> passed, `23` files and `377` tests.
- `npm run build` -> passed.
- Guarded PostgreSQL integration tests:
  - first sandbox attempt failed before tests with DNS `EAI_AGAIN`;
  - approved network rerun passed, `1` file and `16` tests.
- Final read-only RAG DB preflight -> passed: one active `mein-konto` version, `12` active chunks,
  `12` valid active embeddings, no staged or partially embedded versions.
- `git diff --check` -> passed.

## Files Changed

- `scripts/evaluate-rag-retrieval.ts` — added the isolated FAQ-question reranker experiment mode.
- `docs/evaluation/rag-faq-question-reranker-experiment-results.json` — generated deterministic
  result artifact.
- `docs/rag-faq-question-reranker-experiment-report.md` — this report.

## Assumptions And Limitations

- The active working RAG database is the evaluation target for the active 12 `mein-konto` chunks.
- The experiment uses the pinned local E5 embedding profile already configured in the project.
- The same frozen dataset is used; no independent validation dataset exists.
- No production recommendation follows from this rejected offline candidate.

## Recommendation

Do not implement this FAQ-question reranker in production in this form. It fixes the two recoverable
baseline errors but introduces regressions in adjacent wishlist queries.
