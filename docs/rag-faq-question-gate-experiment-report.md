# RAG FAQ Question-Gate Experiment Report

## Scope

Controlled offline retrieval experiment only. No production retrieval behavior, production threshold,
stored embeddings, chunks, active RAG data, routes, ingestion, answer generation, Dialfire assets, or
frozen evaluation dataset were changed.

Durable result artifact:

- `docs/evaluation/rag-faq-question-gate-experiment-results.json`

Unchanged preserved artifacts:

- `docs/evaluation/rag-retrieval-evaluation-results.json`
- `docs/evaluation/rag-brand-token-normalization-experiment-results.json`

The experiment uses only the original query recipe. Brand-token normalization was not used.

## Publish Verification

- Starting `HEAD`: `1f94ec5e3e60e8d4d57536131e8021fa1e4fb162`.
- `HEAD` was verified as a clean descendant of `origin/main`.
- `git push origin main` completed as a normal fast-forward.
- `origin/main` was verified at `1f94ec5e3e60e8d4d57536131e8021fa1e4fb162`.
- No amend, rebase, force-push, or `dialfire/` inclusion was performed.

## Baseline Verification

- Frozen dataset SHA-256:
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- Accepted baseline artifact unchanged: default evaluator output remained byte-for-byte identical to
  `docs/evaluation/rag-retrieval-evaluation-results.json`.
- Read-only RAG DB preflight passed: one `mein-konto` document, active version `1`, `12` active chunks,
  `12` valid active embeddings, no staged versions.

## Method

Baseline Top-3 retrieval and Top-1 selection remain unchanged. For each baseline Top-1 chunk, the
evaluator extracts only the canonical FAQ question from `Frage: ...`, embeds the original user query
with the existing E5 query recipe, embeds the FAQ question with the existing E5 passage recipe, and
uses their cosine similarity as an evaluation-only gate score.

The fixed gate threshold selected for comparison is `0.84`, the best F1 point at retrieval threshold
`0.80` in the fixed `0.50` to `0.95` sweep. This threshold was selected on the same frozen dataset and
has no independent validation. No threshold passed the decision rule.

## Metrics

At retrieval threshold `0.80`, gate threshold `0.84`:

| Variant   | Correct Accepted | Wrong Chunk Accepted | Answerable Abstained | Hard-Negative False Accepts | Irrelevant False Accepts | Correct Rejects |  TP |  FN |  FP |  TN | Precision |   Recall |       F1 |
| --------- | ---------------: | -------------------: | -------------------: | --------------------------: | -----------------------: | --------------: | --: | --: | --: | --: | --------: | -------: | -------: |
| Baseline  |               31 |                    5 |                    0 |                           8 |                        1 |               7 |  36 |   0 |   9 |   7 |  0.800000 | 1.000000 | 0.888889 |
| Candidate |               31 |                    5 |                    0 |                           5 |                        0 |              11 |  36 |   0 |   5 |  11 |  0.878049 | 1.000000 | 0.935065 |

The gate fixed `4/9` baseline false accepts at retrieval threshold `0.80`, which is `44.44%` and does
not meet the required at-least-50% reduction.

At retrieval threshold `0.85`, gate threshold `0.84`:

| Variant   | Correct Accepted | Wrong Chunk Accepted | Answerable Abstained | Hard-Negative False Accepts | Irrelevant False Accepts | Correct Rejects |  TP |  FN |  FP |  TN | Precision |   Recall |       F1 |
| --------- | ---------------: | -------------------: | -------------------: | --------------------------: | -----------------------: | --------------: | --: | --: | --: | --: | --------: | -------: | -------: |
| Baseline  |               31 |                    5 |                    0 |                           4 |                        0 |              12 |  36 |   0 |   4 |  12 |  0.900000 | 1.000000 | 0.947368 |
| Candidate |               31 |                    5 |                    0 |                           4 |                        0 |              12 |  36 |   0 |   4 |  12 |  0.900000 | 1.000000 | 0.947368 |

Precision, recall, and F1 in these tables are answerability-classification metrics. They are not
end-to-end answer correctness metrics and do not indicate that wrong Top-1 answerable cases were
fixed.

Ranking metrics were not altered or used for selection: Top-1 accuracy `0.861111`, Recall@3
`0.916667`, MRR `0.888889`.

## Score Distributions

| Bucket                             |      Min |      P25 |   Median |      P75 |      Max |
| ---------------------------------- | -------: | -------: | -------: | -------: | -------: |
| Correct Top-1 answers              | 0.842081 | 0.870355 | 0.902177 | 0.921402 | 0.940385 |
| Wrong Top-1 answers                | 0.852907 | 0.853362 | 0.858832 | 0.859037 | 0.891760 |
| Unanswerable false accepts at 0.80 | 0.808425 | 0.823111 | 0.842604 | 0.845691 | 0.859390 |
| Unanswerable false accepts at 0.85 | 0.842604 | 0.842604 | 0.845691 | 0.851593 | 0.859390 |

The distributions overlap substantially; this gate is not cleanly separable.

## Changed Decisions

At retrieval threshold `0.80`, gate threshold `0.84`, four decisions changed from false accept to
correct reject:

- `hard-neg-004`: score `0.823111`, Top-1 `mein-konto:v1:chunk-009`.
- `hard-neg-007`: score `0.832342`, Top-1 `mein-konto:v1:chunk-012`.
- `hard-neg-008`: score `0.810500`, Top-1 `mein-konto:v1:chunk-001`.
- `irrelevant-004`: score `0.808425`, Top-1 `mein-konto:v1:chunk-009`.

At retrieval threshold `0.85`, gate threshold `0.84`, no decisions changed.

False accepts remaining after the gate at retrieval threshold `0.80`:

- `hard-neg-001`
- `hard-neg-002`
- `hard-neg-003`
- `hard-neg-005`
- `hard-neg-006`

False accepts remaining after the gate at retrieval threshold `0.85`:

- `hard-neg-001`
- `hard-neg-002`
- `hard-neg-005`
- `hard-neg-006`

## Required Inspection

All nine baseline false accepts at retrieval threshold `0.80`:

- `hard-neg-001`: score `0.842604`, Top-1 `mein-konto:v1:chunk-003`.
- `hard-neg-002`: score `0.859390`, Top-1 `mein-konto:v1:chunk-003`.
- `hard-neg-003`: score `0.843020`, Top-1 `mein-konto:v1:chunk-012`.
- `hard-neg-004`: score `0.823111`, Top-1 `mein-konto:v1:chunk-009`.
- `hard-neg-005`: score `0.845691`, Top-1 `mein-konto:v1:chunk-003`.
- `hard-neg-006`: score `0.851593`, Top-1 `mein-konto:v1:chunk-012`.
- `hard-neg-007`: score `0.832342`, Top-1 `mein-konto:v1:chunk-012`.
- `hard-neg-008`: score `0.810500`, Top-1 `mein-konto:v1:chunk-001`.
- `irrelevant-004`: score `0.808425`, Top-1 `mein-konto:v1:chunk-009`.

All five wrong-answerable Top-1 cases:

- `para-003-a`: expected `mein-konto:v1:chunk-003`, Top-1 `mein-konto:v1:chunk-001`, score
  `0.852907`.
- `para-006-a`: expected `mein-konto:v1:chunk-006`, Top-1 `mein-konto:v1:chunk-001`, score
  `0.859037`.
- `para-009-b`: expected `mein-konto:v1:chunk-009`, Top-1 `mein-konto:v1:chunk-008`, score
  `0.858832`.
- `para-010-b`: expected `mein-konto:v1:chunk-010`, Top-1 `mein-konto:v1:chunk-011`, score
  `0.891760`.
- `para-012-b`: expected `mein-konto:v1:chunk-012`, Top-1 `mein-konto:v1:chunk-001`, score
  `0.853362`.

All five wrong-answerable Top-1 cases remained unchanged by the gate at threshold `0.84`; the gate is
not a reranker and does not recover any wrong Top-1 answer.

Previously correct answerable queries rejected at selected gate threshold `0.84`: none.

## Decision

Candidate rejected. No fixed question-match threshold satisfies the decision rule across retrieval
thresholds `0.80` and `0.85`.

At threshold `0.84`, false accepts fall from `9` to `5` at retrieval threshold `0.80`, which is not at
least a 50% reduction. At retrieval threshold `0.85`, false accepts remain `4`, so the qualitative
result is not the same. Higher gate thresholds can reduce false accepts more, but they reject baseline
correct answerable queries.

Do not change production behavior.

## Verification

- `sha256sum tests/fixtures/rag/retrieval-evaluation-dataset.json` ->
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- `npx --yes tsx scripts/evaluate-rag-retrieval.ts --experiment faq-question-gate --output docs/evaluation/rag-faq-question-gate-experiment-results.json`
  -> passed.
- Default baseline evaluator output was byte-for-byte identical to
  `docs/evaluation/rag-retrieval-evaluation-results.json`.
- `git diff -- docs/evaluation/rag-retrieval-evaluation-results.json docs/evaluation/rag-brand-token-normalization-experiment-results.json`
  -> no diff.
- `npm run typecheck` -> passed.
- `npm run lint` -> passed.
- `npm run format:check` -> first failed because the experiment rerun rewrote the JSON artifact; after
  formatting the artifact, rerun passed.
- `npm test` -> passed, `23` files and `377` tests.
- `npm run build` -> passed.
- `./node_modules/.bin/vitest run tests/integration/rag-postgres-document-store.test.ts --testTimeout 15000`
  -> first attempt failed with sandbox DNS resolution; rerun with approved network access passed, `1`
  file and `16` tests.
- Final `npx --yes tsx scripts/rag-db-preflight.ts` -> passed; the working RAG DB remained one active
  `mein-konto` version with `12` active chunks, `12` valid embeddings, and no staged versions.
- `git diff --check` -> passed.
- No commit was created for this experiment.

## Files Changed

- `scripts/evaluate-rag-retrieval.ts`
- `docs/evaluation/rag-faq-question-gate-experiment-results.json`
- `docs/rag-faq-question-gate-experiment-report.md`

## Confirmation

Production retrieval modules, thresholds, routes, active RAG data, chunks, stored embeddings,
ingestion, answer generation, and Dialfire remain unchanged.
