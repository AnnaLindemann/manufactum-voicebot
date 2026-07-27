# RAG Canonical Question Weighting Experiment Report

## Scope

Controlled offline passage-representation experiment only. Production code, runtime behavior,
thresholds, active chunks, stored embeddings, document versions, database state, Dialfire assets,
historical data, held-out data, accepted files, and `dialfire/` were not changed or inspected.

Created files:

- `scripts/evaluate-rag-canonical-question-weighting.ts`
- `tests/unit/rag-canonical-question-weighting.test.ts`
- `docs/evaluation/rag-canonical-question-weighting-experiment-results.json`
- `docs/rag-canonical-question-weighting-experiment-report.md`

## Preflight And Control Reproduction

- Branch: `main`.
- `HEAD`: `b26dc56821cd292413234a477ab0bb468de2a510`.
- `origin/main`: `b26dc56821cd292413234a477ab0bb468de2a510`.
- Tracked changes before experiment: none.
- Only unrelated untracked path before experiment: `dialfire/`.
- Accepted control artifact:
  `docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json`.
- Accepted control SHA-256:
  `13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d`.

Frozen identities verified:

- Development dataset SHA-256:
  `523464871475a6c921d7de7b75beb9591aea7261d8719dc4a180117fb1d82dbc`.
- Accepted baseline artifact SHA-256:
  `303ed62a9b263c45ef4c203ee25da07f019c804c6c24a0d5e23c2ef6340fcf1f`.
- Accepted evidence mapping SHA-256:
  `828aa3913a9cf13a9127f3e6505a0c5dc024e9d58efc7cbe382d028b9bab1d69`.
- Active chunk set: `12/12` chunks matched the accepted artifact by index, key, and content hash.

Control reproduction:

- All `12` accepted control passage representation hashes matched the accepted canonicalization
  artifact.
- Every control passage contained exactly one standalone `Manufactum`.
- All `96/96` query embedding input hashes were byte-identical to accepted control behavior.
- All `96/96` reproduced control rank orderings were identical to the accepted control artifact.
- Maximum absolute control score delta: `0`.
- Reproduced control metrics: Recall@1 `0.944444`, Recall@3 `1.000000`, MRR `0.969907`.

No `control_mismatch` occurred; candidate evaluation proceeded.

## Representations

Control rule:

```text
Marke: Manufactum

Frage: {canonicalizedQuestion}

Antwort: {canonicalizedAnswer}
```

Candidate rule:

```text
Marke: Manufactum

Frage: {canonicalizedQuestion}

Frage: {canonicalizedQuestion}

Antwort: {canonicalizedAnswer}
```

The two candidate `Frage` fields are byte-identical. The exact control and candidate representation
strings for all `12` chunks are recorded in
`docs/evaluation/rag-canonical-question-weighting-experiment-results.json` under
`controlPassageInputs[].representation` and `candidatePassageInputs[].representation`.

## Independent Variable Proof

- Changed only the number of occurrences of the canonicalized source FAQ question in the passage
  embedding input.
- Reused the accepted brand canonicalization builder from
  `scripts/evaluate-rag-passage-brand-context-canonicalization.ts`.
- The candidate construction function accepts only `originalQuestion` and `originalAnswer`.
- Query text, query embedding behavior, E5 prefixes, model, revision, artifact, dimension, pooling,
  normalization, similarity calculation, ranking scope, Top-K, and thresholds were unchanged.
- Candidate embeddings were generated transiently in memory and were not written to PostgreSQL.
- Ranking covered the complete active `12`-chunk set for every query.
- No query IDs, expected evidence IDs, `faqIntentId` values, labels, ranks, or outcomes influenced
  representation construction.

Candidate invariants:

- all `12` passages covered exactly once;
- every candidate contains exactly one standalone `Manufactum`;
- every candidate contains its canonicalized question exactly twice;
- both question occurrences are byte-identical;
- every candidate contains the canonicalized answer exactly once;
- no candidate contains content from another chunk;
- candidate ordering is deterministic.

## Metric Comparison

| Variant   | Answerable | Recall@1 | Recall@3 |      MRR |
| --------- | ---------: | -------: | -------: | -------: |
| Control   |         72 | 0.944444 | 1.000000 | 0.969907 |
| Candidate |         72 | 0.958333 | 1.000000 | 0.976852 |
| Delta     |          - | 0.013889 | 0.000000 | 0.006945 |

By query type:

| Query Type           | Count | Answerable | Candidate R@1 | Candidate R@3 | Candidate MRR |
| -------------------- | ----: | ---------: | ------------: | ------------: | ------------: |
| ambiguous_answerable |    12 |         12 |      0.750000 |      1.000000 |      0.861111 |
| conversational       |    12 |         12 |      1.000000 |      1.000000 |      1.000000 |
| exact                |    12 |         12 |      1.000000 |      1.000000 |      1.000000 |
| paraphrased          |    24 |         24 |      1.000000 |      1.000000 |      1.000000 |
| short                |    12 |         12 |      1.000000 |      1.000000 |      1.000000 |
| hard_negative        |    18 |          0 |           n/a |           n/a |           n/a |
| irrelevant           |     6 |          0 |           n/a |           n/a |           n/a |

By FAQ intent, the remaining imperfect intents were:

| FAQ Intent                                                    | Candidate R@1 | Candidate R@3 | Candidate MRR |
| ------------------------------------------------------------- | ------------: | ------------: | ------------: |
| account-faq:kann-ich-meine-merkliste-mit-anderen-teilen       |      0.833333 |      1.000000 |      0.916667 |
| account-faq:wie-funktioniert-die-mit-mir-geteilte-wunschliste |      0.833333 |      1.000000 |      0.916667 |
| account-faq:wie-nutze-ich-die-merkliste                       |      0.833333 |      1.000000 |      0.888889 |

All other FAQ intents reached candidate Recall@1 `1.000000`.

## Rank And Top-1 Changes

Every answerable query whose first acceptable rank changed:

| Query ID              | Control Rank | Control Top-1           | Control Top-1 Score | Control Expected Score | Candidate Rank | Candidate Top-1         | Candidate Top-1 Score | Candidate Expected Score |
| --------------------- | -----------: | ----------------------- | ------------------: | ---------------------: | -------------: | ----------------------- | --------------------: | -----------------------: |
| mein-konto-v1-dev-015 |            2 | mein-konto:v1:chunk-012 |            0.900026 |               0.899823 |              1 | mein-konto:v1:chunk-002 |              0.900512 |                 0.900512 |

Changed Top-1 predictions:

- `mein-konto-v1-dev-015`

Newly corrected Top-1 queries:

- `mein-konto-v1-dev-015`

Previously correct Top-1 queries that regressed:

- none

Remaining incorrect Top-1 queries:

- `mein-konto-v1-dev-067`
- `mein-konto-v1-dev-068`
- `mein-konto-v1-dev-069`

## Target Failure Details

| Query ID              | Control Rank | Candidate Rank | Control Top-1           | Candidate Top-1         | Control Expected Score | Candidate Expected Score |
| --------------------- | -----------: | -------------: | ----------------------- | ----------------------- | ---------------------: | -----------------------: |
| mein-konto-v1-dev-015 |            2 |              1 | mein-konto:v1:chunk-012 | mein-konto:v1:chunk-002 |               0.899823 |                 0.900512 |
| mein-konto-v1-dev-067 |            3 |              3 | mein-konto:v1:chunk-009 | mein-konto:v1:chunk-009 |               0.826958 |                 0.822196 |
| mein-konto-v1-dev-068 |            2 |              2 | mein-konto:v1:chunk-009 | mein-konto:v1:chunk-009 |               0.822119 |                 0.820125 |
| mein-konto-v1-dev-069 |            2 |              2 | mein-konto:v1:chunk-008 | mein-konto:v1:chunk-008 |               0.885387 |                 0.883004 |

Only one of the four target failures became Top-1 correct.

## Same-Intent And 008/009 Analysis

Same-intent query set for the four target failures contained `24` answerable queries. Only
`mein-konto-v1-dev-015` changed rank or Top-1; no same-intent regression occurred.

Merkliste/Wunschliste pair analysis for chunks `008` and `009`:

- Remaining failures are still in the Merkliste/Wunschliste cluster: `067`, `068`, `069`.
- `067`: stayed rank `3`, Top-1 remained chunk `009`.
- `068`: stayed rank `2`, Top-1 remained chunk `009`.
- `069`: stayed rank `2`, Top-1 remained chunk `008`.
- Top-1 selection counts shifted slightly: chunk `008` `8 -> 7`, chunk `009` `11 -> 11`.

Top-1 selection counts:

| Chunk                   | Control | Candidate |
| ----------------------- | ------: | --------: |
| mein-konto:v1:chunk-001 |       9 |         9 |
| mein-konto:v1:chunk-002 |       7 |         8 |
| mein-konto:v1:chunk-003 |       8 |         8 |
| mein-konto:v1:chunk-004 |       8 |         8 |
| mein-konto:v1:chunk-005 |       7 |         7 |
| mein-konto:v1:chunk-006 |       7 |         7 |
| mein-konto:v1:chunk-007 |       7 |         8 |
| mein-konto:v1:chunk-008 |       8 |         7 |
| mein-konto:v1:chunk-009 |      11 |        11 |
| mein-konto:v1:chunk-010 |       6 |         6 |
| mein-konto:v1:chunk-011 |       9 |         9 |
| mein-konto:v1:chunk-012 |       9 |         8 |

For the sole correction, the control expected-minus-wrong-Top-1 gap was `-0.000203`; candidate
expected-minus-wrong-Top-1 is `0` because the expected chunk became Top-1.

## Unanswerable And Score Scale

No threshold was tuned or applied.

All `24` unanswerable query top scores are recorded in the JSON artifact under
`comparisons.unanswerableTopScores`.

Unanswerable score shifts:

| Group         | Count | Min Delta | Max Delta | Mean Delta |
| ------------- | ----: | --------: | --------: | ---------: |
| hard_negative |    18 | -0.006952 |  0.007051 |   0.000250 |
| irrelevant    |     6 | -0.005796 |  0.003629 |   0.000152 |

Overall top-score scale shifts:

| Scope        | Count | Min Delta | P50 Delta | P90 Delta | Max Delta | Mean Delta |
| ------------ | ----: | --------: | --------: | --------: | --------: | ---------: |
| all queries  |    96 | -0.007770 |  0.000519 |  0.005821 |  0.017847 |   0.000759 |
| answerable   |    72 | -0.007770 |  0.000486 |  0.006836 |  0.017847 |   0.000937 |
| unanswerable |    24 | -0.006952 |  0.000742 |  0.004910 |  0.007051 |   0.000226 |

Interpretation: score-scale movement was small and mixed. This experiment does not support any
production threshold claim.

## Decision

Decision: `experiment_rejected`.

Passed criteria:

- Recall@1 is above `0.944444`: `0.958333`.
- Candidate has at least `69/72` correct Top-1 results: `69/72`.
- Recall@3 remains `1.000000`.
- MRR is above `0.969907`: `0.976852`.
- Corrected Top-1 count minus regressed Top-1 count is at least one: `1 - 0 = 1`.
- No more than one previously correct answerable query loses Top-1: `0`.
- Candidate rule was applied uniformly to all `12` passages.
- No leakage or uncontrolled independent-variable change was found.

Failed criterion:

- At least two of `015`, `067`, `068`, and `069` become Top-1 correct: only `1/4`.

The success criteria were not weakened after seeing the result.

## Validation

Completed:

- `npx --yes tsx scripts/evaluate-rag-canonical-question-weighting.ts --output docs/evaluation/rag-canonical-question-weighting-experiment-results.json`
  -> passed on the first full run and generated the experiment artifact.
- `./node_modules/.bin/vitest run tests/unit/rag-canonical-question-weighting.test.ts` -> passed,
  `7` tests.
- `npm run typecheck` -> passed.
- `npm run lint` -> passed.
- `npm run format:check` -> passed.
- `npm test` -> passed, `28` files and `405` tests.
- `git diff --check -- . ':!dialfire/'` -> passed.
- `git diff --no-index --check /dev/null <new-file>` for each new experiment file -> no whitespace
  error output.

Final `git status --short`:

```text
?? dialfire/
?? docs/evaluation/rag-canonical-question-weighting-experiment-results.json
?? docs/rag-canonical-question-weighting-experiment-report.md
?? scripts/evaluate-rag-canonical-question-weighting.ts
?? tests/unit/rag-canonical-question-weighting.test.ts
```

## Assumptions

- The accepted canonicalization result artifact is the authoritative offline control.
- The active local RAG database contains the same `mein-konto` active chunk set described by the
  accepted artifacts.
- The local embedding runtime/cache uses the pinned E5 profile recorded in the accepted artifacts.

## Limitations

- This is an offline passage-representation experiment, not an activation plan.
- Candidate embeddings were transient and were not stored.
- No answerability threshold was selected, tuned, or validated.
- The experiment corrected only the account-benefits failure `015`; it did not resolve the remaining
  Merkliste/Wunschliste relationship failures.

## Documentation Changes

- Added this experiment report.
- Added the generated experiment results JSON.
- Accepted experiment files were not changed.

## Recommendation

Stop after this experiment as requested. Do not activate the candidate. A future experiment would need a
separate approved scope because this candidate was rejected by the fixed success criteria.
