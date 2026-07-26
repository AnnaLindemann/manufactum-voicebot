# RAG Brand-Token Normalization Experiment Report

## Scope

Controlled offline retrieval experiment only. No production retrieval behavior, production threshold,
stored embeddings, chunks, active RAG data, routes, ingestion, Dialfire assets, or frozen evaluation
dataset were changed.

Durable result artifact:

- `docs/evaluation/rag-brand-token-normalization-experiment-results.json`

The accepted baseline artifact remains preserved separately at
`docs/evaluation/rag-retrieval-evaluation-results.json` and was restored byte-for-byte from commit
`5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.

## Baseline Verification

- `HEAD`: `5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.
- `origin/main`: `5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.
- Frozen dataset SHA-256:
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- Read-only RAG DB preflight passed before the experiment: one `mein-konto` document, active version
  `1`, `12` active chunks, `12` valid active embeddings, no staged versions.

## Brand-Token Finding

The exact list of answerable queries containing standalone token `Manufactum` has `11` queries:

- `exact-001`
- `exact-010`
- `exact-011`
- `para-001-a`
- `para-001-b`
- `para-003-a`
- `para-006-a`
- `para-010-a`
- `para-010-b`
- `para-011-a`
- `para-012-b`

Stored baseline result: `7` currently succeed at Top-1 and `4` currently fail at Top-1. The previous
statement "`11 currently-correct brand queries`" was incorrect; the correct interpretation is `11`
brand-containing answerable queries, of which `7` are currently correct and `4` fail.

## Recipes

- Baseline: `query: ${originalQuery}` through the existing E5 query prefix path.
- Candidate: remove only standalone, case-insensitive `Manufactum`, normalize whitespace, then use the
  same existing E5 `query: ` prefix. This is implemented as
  `experimental-manufactum-token-normalized` and is evaluation-only.

## Metrics

| Variant   | Top-1 Accuracy | Recall@3 |      MRR |
| --------- | -------------: | -------: | -------: |
| Baseline  |       0.861111 | 0.916667 | 0.888889 |
| Candidate |       0.888889 | 1.000000 | 0.939815 |

At threshold `0.80`:

| Variant   | Correct Accepted | Wrong Chunk Accepted | Answerable Abstained | Hard-Negative False Accepts | Irrelevant False Accepts | Correct Rejects |
| --------- | ---------------: | -------------------: | -------------------: | --------------------------: | -----------------------: | --------------: |
| Baseline  |               31 |                    5 |                    0 |                           8 |                        1 |               7 |
| Candidate |               32 |                    4 |                    0 |                           8 |                        1 |               7 |

At threshold `0.85`:

| Variant   | Correct Accepted | Wrong Chunk Accepted | Answerable Abstained | Hard-Negative False Accepts | Irrelevant False Accepts | Correct Rejects |
| --------- | ---------------: | -------------------: | -------------------: | --------------------------: | -----------------------: | --------------: |
| Baseline  |               31 |                    5 |                    0 |                           4 |                        0 |              12 |
| Candidate |               32 |                    4 |                    0 |                           4 |                        0 |              12 |

False accepts did not improve: candidate false-accept counts are identical to baseline at both `0.80`
and `0.85`.

Answerability confusion matrix:

| Variant   | Threshold |  TP |  FN |  FP |  TN |
| --------- | --------: | --: | --: | --: | --: |
| Baseline  |      0.80 |  36 |   0 |   9 |   7 |
| Candidate |      0.80 |  36 |   0 |   9 |   7 |
| Baseline  |      0.85 |  36 |   0 |   4 |  12 |
| Candidate |      0.85 |  36 |   0 |   4 |  12 |

The full `0.50` to `0.95` sweep for both variants is in
`docs/evaluation/rag-brand-token-normalization-experiment-results.json`.

## Changed Queries

Ranking or decision changed for:

- `exact-001`
- `exact-010`
- `exact-011`
- `para-001-a`
- `para-001-b`
- `para-003-a`
- `para-006-a`
- `para-010-a`
- `para-010-b`
- `para-011-a`
- `para-012-b`

Decision changes at both `0.80` and `0.85`:

- Recovered: `para-003-a`, `para-006-a`, `para-012-b`.
- Regressed: `para-001-a`, `para-010-a`.

## Primary Canaries

- `para-003-a`: baseline Top-3 `001` 0.883672, `010` 0.883096, `011` 0.865988; expected absent,
  margin 0.000576. Candidate Top-3 `003` 0.918408, `012` 0.853082, `001` 0.833561; expected rank 1,
  margin 0.065326.
- `para-006-a`: baseline Top-3 `001` 0.884550, `010` 0.863152, `011` 0.862152; expected absent,
  margin 0.021398. Candidate Top-3 `006` 0.904318, `005` 0.862927, `002` 0.817805; expected rank 1,
  margin 0.041390.
- `para-012-b`: baseline Top-3 `001` 0.881850, `011` 0.881697, `010` 0.881225; expected absent,
  margin 0.000153. Candidate Top-3 `012` 0.905489, `006` 0.847312, `005` 0.845040; expected rank 1,
  margin 0.058177.

## Decision

The candidate is rejected and must not proceed to a later production-design checkpoint in this form.
It recovers all three canaries, improves Top-1 accuracy from `0.861111` to `0.888889`, improves
Recall@3 from `0.916667` to `1.000000`, and improves MRR from `0.888889` to `0.939815`. False accepts
did not improve, and it regresses currently correct answerable queries:

- `para-001-a`: expected `chunk-001`, candidate Top-1 `chunk-012`.
- `para-010-a`: expected `chunk-010`, candidate Top-1 `chunk-011`.

Production retrieval behavior and production threshold remain unchanged.

## Verification

- `git rev-parse HEAD` -> `5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.
- `git rev-parse origin/main` -> `5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.
- `sha256sum tests/fixtures/rag/retrieval-evaluation-dataset.json` ->
  `458e6958997a7838693c1ac96c102deee0c991fc4d2bd8a9abb3875b96461197`.
- `npx --yes tsx scripts/rag-db-preflight.ts` -> passed before and after the experiment; the working
  RAG DB remained one active `mein-konto` version with `12` active chunks, `12` valid embeddings, and
  no staged versions.
- `npx --yes tsx scripts/evaluate-rag-retrieval.ts --experiment brand-token-normalization --output docs/evaluation/rag-brand-token-normalization-experiment-results.json`
  -> passed.
- `npm run typecheck` -> passed.
- `npm run lint` -> passed.
- `npm run format:check` -> passed.
- `npm test` -> passed, `23` files and `377` tests.
- `npm run build` -> passed.
- `./node_modules/.bin/vitest run tests/integration/rag-postgres-document-store.test.ts --testTimeout 15000`
  -> first attempt failed with DNS/network resolution in the sandbox; rerun with approved network
  access passed, `1` file and `16` tests.
- `git diff --check` -> passed.
- `git diff -- docs/evaluation/rag-retrieval-evaluation-results.json` -> no diff after restoring the
  accepted baseline artifact from commit `5d3c1bfa4c555a99c84b8a4de1f505ab7eea389f`.

## Files Changed

- `scripts/evaluate-rag-retrieval.ts`
- `docs/evaluation/rag-brand-token-normalization-experiment-results.json`
- `docs/rag-brand-token-normalization-experiment-report.md`

## Assumptions And Limitations

- The active working RAG database is the evaluation target for the active 12 chunks.
- The experiment uses the pinned local E5 embedding profile already configured in the project.
- This is not a production recommendation and does not adopt threshold `0.85`.

## Next Recommendation

Do not implement this exact normalization recipe in production. Investigate a narrower design that
does not strip `Manufactum` when it disambiguates account creation or newsletter subscription intents.
