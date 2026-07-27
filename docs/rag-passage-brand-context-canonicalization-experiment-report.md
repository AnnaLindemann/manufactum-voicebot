# RAG Passage Brand-Context Canonicalization Experiment Report

## Scope

Controlled offline passage-representation experiment only. No production retrieval code, runtime
behavior, thresholds, routes, ingestion, active chunks, stored embeddings, document versions, database
state, Dialfire assets, historical dataset, or held-out data were changed.

Generated artifact:

- `docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json`

Dedicated evaluation script:

- `scripts/evaluate-rag-passage-brand-context-canonicalization.ts`

Focused tests:

- `tests/unit/rag-passage-brand-context-canonicalization.test.ts`

## Accepted Baseline

- Branch: `main`.
- `HEAD`: `2284938c3413b86c1e0a24f57ad7fdee9610b874`.
- `origin/main`: `2284938c3413b86c1e0a24f57ad7fdee9610b874`.
- Frozen development dataset:
  `tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json`.
- Dataset SHA-256:
  `523464871475a6c921d7de7b75beb9591aea7261d8719dc4a180117fb1d82dbc`.
- Accepted baseline artifact:
  `docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json`.
- Accepted mapping artifact:
  `docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json`.

The script verified that the frozen dataset has `96` deterministic IDs, the accepted baseline has the
same query order, and the accepted evidence-to-chunk mapping matches the accepted frozen-input hashes.

## Representation Rules

Control passage representation:

```text
Frage: {originalQuestion}

Antwort: {originalAnswer}
```

Candidate passage representation:

```text
Marke: Manufactum

Frage: {originalQuestion with standalone case-insensitive occurrences of "Manufactum" removed}

Antwort: {originalAnswer with standalone case-insensitive occurrences of "Manufactum" removed}
```

Whitespace created by removal is collapsed to single spaces and trimmed. The E5 production passage
prefix `passage: ` is still applied by the exact production embedding implementation.

## Independent Variable Proof

- Changed only candidate passage embedding input representation.
- Query text and query embedding behavior were unchanged: `96/96` query embedding input hashes are
  byte-identical to the accepted baseline.
- Candidate passage embeddings were generated transiently in memory with
  `TransformersE5SmallPassageEmbeddingGenerator`.
- Candidate embeddings were not written to PostgreSQL.
- Ranking used the complete `12` active chunk set and the accepted evidence-to-chunk mapping.
- Model, pinned revision, artifact, dimension, pooling, normalization, E5 prefixes, similarity
  function, top-k for recall, deterministic ordering, and thresholds were unchanged.
- Every candidate passage input contains exactly one standalone `Manufactum` occurrence: `12/12`.
- The frozen dataset, accepted baseline artifact, and accepted mapping artifact were rehashed after the
  experiment and remained unchanged.

## Metric Comparison

| Variant   | Answerable | Recall@1 | Recall@3 |      MRR |
| --------- | ---------: | -------: | -------: | -------: |
| Baseline  |         72 | 0.847222 | 0.902778 | 0.895139 |
| Candidate |         72 | 0.944444 | 1.000000 | 0.969907 |
| Delta     |          - | 0.097222 | 0.097222 | 0.074768 |

By query type:

| Query Type           | Count | Answerable | Baseline R@1 | Baseline R@3 | Baseline MRR | Candidate R@1 | Candidate R@3 | Candidate MRR |
| -------------------- | ----: | ---------: | -----------: | -----------: | -----------: | ------------: | ------------: | ------------: |
| ambiguous_answerable |    12 |         12 |     0.666667 |     0.833333 |     0.770833 |      0.750000 |      1.000000 |      0.861111 |
| conversational       |    12 |         12 |     0.916667 |     0.916667 |     0.933333 |      1.000000 |      1.000000 |      1.000000 |
| exact                |    12 |         12 |     1.000000 |     1.000000 |     1.000000 |      1.000000 |      1.000000 |      1.000000 |
| paraphrased          |    24 |         24 |     0.791667 |     0.875000 |     0.864583 |      0.958333 |      1.000000 |      0.979167 |
| short                |    12 |         12 |     0.916667 |     0.916667 |     0.937500 |      1.000000 |      1.000000 |      1.000000 |
| hard_negative        |    18 |          0 |          n/a |          n/a |          n/a |           n/a |           n/a |           n/a |
| irrelevant           |     6 |          0 |          n/a |          n/a |          n/a |           n/a |           n/a |           n/a |

By FAQ intent:

| FAQ Intent                                                       | Baseline R@1 | Baseline R@3 | Baseline MRR | Candidate R@1 | Candidate R@3 | Candidate MRR |
| ---------------------------------------------------------------- | -----------: | -----------: | -----------: | ------------: | ------------: | ------------: |
| account-faq:ich-habe-mein-passwort-vergessen-was-kann-ich-tun    |     1.000000 |     1.000000 |     1.000000 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:ich-moechte-mein-passwort-aendern-was-kann-ich-tun   |     1.000000 |     1.000000 |     1.000000 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:kann-ich-meine-merkliste-mit-anderen-teilen          |     1.000000 |     1.000000 |     1.000000 |      0.833333 |      1.000000 |      0.916667 |
| account-faq:welche-vorteile-bietet-mir-ein-konto                 |     0.666667 |     0.666667 |     0.750000 |      0.833333 |      1.000000 |      0.916667 |
| account-faq:wie-funktioniert-die-mit-mir-geteilte-wunschliste    |     0.666667 |     0.666667 |     0.727778 |      0.833333 |      1.000000 |      0.916667 |
| account-faq:wie-kann-ich-den-manufactum-newsletter-abonnieren    |     0.833333 |     1.000000 |     0.916667 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:wie-kann-ich-mein-kundenkonto-loeschen               |     0.666667 |     0.666667 |     0.750000 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:wie-kann-ich-meine-e-mail-adresse-aendern            |     0.666667 |     0.833333 |     0.791667 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:wie-kann-ich-mich-bei-manufactum-registrieren        |     0.833333 |     1.000000 |     0.916667 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:wie-kann-ich-mich-vom-manufactum-newsletter-abmelden |     1.000000 |     1.000000 |     1.000000 |      1.000000 |      1.000000 |      1.000000 |
| account-faq:wie-nutze-ich-die-merkliste                          |     0.833333 |     1.000000 |     0.888889 |      0.833333 |      1.000000 |      0.888889 |
| account-faq:wo-finde-ich-meine-kundennummer                      |     1.000000 |     1.000000 |     1.000000 |      1.000000 |      1.000000 |      1.000000 |

## Rank Changes

Every answerable query whose first acceptable rank changed:

| Query ID              | Type                 | Baseline Rank | Baseline Top-1 | Baseline Top-1 Score | Baseline Expected Score | Candidate Rank | Candidate Top-1 | Candidate Top-1 Score | Candidate Expected Score |
| --------------------- | -------------------- | ------------: | -------------- | -------------------: | ----------------------: | -------------: | --------------- | --------------------: | -----------------------: |
| mein-konto-v1-dev-014 | paraphrased          |             2 | chunk-012      |             0.859435 |                0.855513 |              1 | chunk-001       |              0.859716 |                 0.859716 |
| mein-konto-v1-dev-015 | paraphrased          |             4 | chunk-001      |             0.902186 |                0.836698 |              2 | chunk-012       |              0.900026 |                 0.899823 |
| mein-konto-v1-dev-020 | paraphrased          |             4 | chunk-010      |             0.892085 |                0.834457 |              1 | chunk-004       |              0.918051 |                 0.918051 |
| mein-konto-v1-dev-031 | paraphrased          |             2 | chunk-011      |             0.915473 |                0.915323 |              1 | chunk-010       |              0.914830 |                 0.914830 |
| mein-konto-v1-dev-035 | paraphrased          |             4 | chunk-001      |             0.891453 |                0.834457 |              1 | chunk-012       |              0.897546 |                 0.897546 |
| mein-konto-v1-dev-048 | short                |             4 | chunk-001      |             0.881599 |                0.847476 |              1 | chunk-012       |              0.914440 |                 0.914440 |
| mein-konto-v1-dev-057 | conversational       |             5 | chunk-001      |             0.862702 |                0.852506 |              1 | chunk-009       |              0.902580 |                 0.902580 |
| mein-konto-v1-dev-062 | ambiguous_answerable |             4 | chunk-001      |             0.908460 |                0.823064 |              1 | chunk-002       |              0.899218 |                 0.899218 |
| mein-konto-v1-dev-064 | ambiguous_answerable |             2 | chunk-001      |             0.852430 |                0.851308 |              1 | chunk-004       |              0.868063 |                 0.868063 |
| mein-konto-v1-dev-068 | ambiguous_answerable |             1 | chunk-008      |             0.824138 |                0.824138 |              2 | chunk-009       |              0.825624 |                 0.822119 |
| mein-konto-v1-dev-069 | ambiguous_answerable |             6 | chunk-008      |             0.855740 |                0.834227 |              2 | chunk-008       |              0.900058 |                 0.885387 |

Newly corrected Top-1 queries:

- `mein-konto-v1-dev-014`
- `mein-konto-v1-dev-020`
- `mein-konto-v1-dev-031`
- `mein-konto-v1-dev-035`
- `mein-konto-v1-dev-048`
- `mein-konto-v1-dev-057`
- `mein-konto-v1-dev-062`
- `mein-konto-v1-dev-064`

Previously correct Top-1 queries that regressed:

- `mein-konto-v1-dev-068`: baseline rank `1`, candidate rank `2`.

Changes among target IDs `014`, `015`, `020`, `035`, `048`, `062`:

- `014`: rank `2 -> 1`, corrected Top-1.
- `015`: rank `4 -> 2`, improved but not Top-1.
- `020`: rank `4 -> 1`, corrected Top-1.
- `035`: rank `4 -> 1`, corrected Top-1.
- `048`: rank `4 -> 1`, corrected Top-1.
- `062`: rank `4 -> 1`, corrected Top-1.

Five of the six target brand-asymmetry failures became Top-1 correct.

Changes among `057` and `069`:

- `057`: rank `5 -> 1`, corrected Top-1.
- `069`: rank `6 -> 2`, improved but not Top-1.

All changes for currently correct brand-containing answerable queries:

- None. No currently correct answerable query containing standalone `Manufactum` changed rank.

Improvements are not limited to exact-string behavior: newly corrected Top-1 queries include
`paraphrased`, `short`, `conversational`, and `ambiguous_answerable` query types; exact queries were
already `1.000000` Recall@1 in the accepted baseline and remained unchanged.

## Unanswerable Scores And Score Scale

No threshold was tuned or applied. Top-score distributions were recorded only.

| Group         | Variant   | Count | Min Top Score | P50 Top Score | P90 Top Score | Max Top Score | Mean Top Score |
| ------------- | --------- | ----: | ------------: | ------------: | ------------: | ------------: | -------------: |
| answerable    | baseline  |    72 |      0.824138 |      0.902036 |      0.928958 |      0.943350 |       0.897542 |
| answerable    | candidate |    72 |      0.825624 |      0.898395 |      0.919655 |      0.939462 |       0.894731 |
| hard_negative | baseline  |    18 |      0.832155 |      0.869913 |      0.905400 |      0.927684 |       0.873008 |
| hard_negative | candidate |    18 |      0.830811 |      0.869405 |      0.924185 |      0.924778 |       0.875573 |
| irrelevant    | baseline  |     6 |      0.769557 |      0.785756 |      0.835173 |      0.835173 |       0.794114 |
| irrelevant    | candidate |     6 |      0.775865 |      0.793054 |      0.844766 |      0.844766 |       0.800868 |

Score-scale shift over paired query top scores:

| Scope        | Count | Min Delta | P50 Delta | P90 Delta | Max Delta | Mean Delta |
| ------------ | ----: | --------: | --------: | --------: | --------: | ---------: |
| all queries  |    96 | -0.022774 | -0.003167 |  0.009593 |  0.047861 |  -0.001205 |
| answerable   |    72 | -0.022774 | -0.004842 |  0.006093 |  0.044318 |  -0.002811 |
| unanswerable |    24 | -0.010906 | -0.001417 |  0.009593 |  0.047861 |   0.003612 |

Interpretation: ranking changed materially while top-score scale moved only mildly on average. The
candidate improves ranking quality, but unanswerable scores do not monotonically decrease; this
experiment does not support threshold tuning.

## Decision

Decision: `experiment_passed`.

Success criteria:

- Recall@1 improved above `0.847222`: `0.944444`.
- At least four of `014`, `015`, `020`, `035`, `048`, `062` became Top-1 correct: `5/6`.
- Recall@3 did not fall below `0.902778`: `1.000000`.
- MRR improved above `0.895139`: `0.969907`.
- No more than one previously correct answerable query lost Top-1: `1`.
- Improvements were not limited to exact-string behavior.

Rejection criteria were not met.

## Validation

Completed:

- `npm run typecheck` -> passed.
- `npx --yes tsx scripts/evaluate-rag-passage-brand-context-canonicalization.ts --output docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json`
  -> passed.
- `./node_modules/.bin/vitest run tests/unit/rag-passage-brand-context-canonicalization.test.ts`
  -> passed, `6` tests.
- `npm run lint` -> passed.
- `npm run format:check` -> passed.
- `npm test` -> passed, `27` files and `398` tests.
- `git diff --check -- . ':!dialfire/'` -> passed.
- `git diff --no-index --check /dev/null <new-file>` for each new experiment file -> no whitespace
  error output.

Final git status:

```text
?? dialfire/
?? docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json
?? docs/rag-passage-brand-context-canonicalization-experiment-report.md
?? scripts/evaluate-rag-passage-brand-context-canonicalization.ts
?? tests/unit/rag-passage-brand-context-canonicalization.test.ts
```

## Files Created Or Changed

- `scripts/evaluate-rag-passage-brand-context-canonicalization.ts`
- `tests/unit/rag-passage-brand-context-canonicalization.test.ts`
- `docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json`
- `docs/rag-passage-brand-context-canonicalization-experiment-report.md`

## Assumptions

- The accepted baseline artifacts named in the request are the authoritative control for comparison.
- The active local RAG database contains the same `mein-konto` active chunk set described by the
  accepted baseline artifact.
- The production embedding cache/model files available to the environment are the pinned profile.

## Limitations

- This is a passage-representation result, not an activation plan.
- Candidate passage embeddings were transient and offline; no production latency or storage impact was
  measured.
- No answerability threshold was selected.

## Confirmations

- Production code and runtime behavior were untouched.
- Database state was read-only during the experiment.
- Active chunks, stored embeddings, document versions, and thresholds were untouched.
- Historical 52-query dataset and historical reports were not used by the new evaluator.
- Held-out data was not inspected or created.
- `dialfire/` was not inspected or modified.
- No files were staged, committed, pushed, or activated.

## Recommendation

Stop after this experiment report, as requested. The candidate passed the offline development criteria
and should be considered only as an accepted experiment result, not as a production change.
