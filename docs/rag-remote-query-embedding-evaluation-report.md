# RAG remote query embedding evaluation report

Gate 5. Read-only comparison of the existing local query embedding against the Hugging Face hosted `intfloat/multilingual-e5-small` endpoint over the frozen 96-query `mein-konto` v1 development dataset, under the unchanged production retrieval contract.

**Verdict: PASS WITH OBSERVATIONS**

## What this experiment did and did not do

- It changed no production code. No `QueryEmbeddingProvider` exists; the remote call lives in `scripts/evaluate-rag-remote-query-embedding.ts` and is not intended to survive into `src/`.
- It changed nothing about the retrieval space. The SQL passage-embedding filter bound the frozen `RAG_EMBEDDING_PROFILE` (`local-transformers-js:xenova-multilingual-e5-small:ae61bf0193ce3851dc8a45147e459b04ed783d8a:onnx-model-quantized:int8:v1`) for **both** arms. The Hugging Face model identity, provider, revision, and dtype never entered that filter.
- It used the production retrieval contract unchanged: `maxChunks = 3`, threshold `0.80`, the existing deterministic ranking, and the existing 12 stored passage embeddings.
- The database session was read-only server-side and re-verified before every retrieval. No row was inserted, updated, deleted, staged, or activated.
- The frozen dataset, the manifest, and the accepted evidence→chunk mapping were verified by SHA-256 against the hashes recorded in the accepted baseline before any query ran.

## Anchoring to the accepted baseline

The local arm was recomputed rather than lifted from the accepted baseline artifact, because that artifact ranks the complete twelve-chunk set with no threshold, while this comparison must run under the production contract. The recomputed arm was then checked against the accepted baseline's first 3 ranks: **96/96** queries reproduce it exactly at six-decimal precision. A divergence here would have meant the corpus, the profile, or the model cache had moved, and the run would have stopped before the remote arm.

## Classification vocabulary

A query is **accepted** when at least one of the returned `maxChunks` scores at or above `0.80` — that is, when the production retrieval path would return anything at all.

| Term           | Applies to   | Meaning                                                            |
| -------------- | ------------ | ------------------------------------------------------------------ |
| correct accept | answerable   | accepted, and an accepted chunk fully covers the labelled evidence |
| wrong accept   | answerable   | accepted, but no accepted chunk covers the labelled evidence       |
| false reject   | answerable   | rejected although the corpus can answer it                         |
| correct reject | unanswerable | rejected, as it should be                                          |
| false accept   | unanswerable | accepted, so an answer would be grounded in an uncovering passage  |

## Arm summaries

| Metric            | Local         | Remote        |
| ----------------- | ------------- | ------------- |
| Total queries     | 96            | 96            |
| Answerable        | 72            | 72            |
| Unanswerable      | 24            | 24            |
| Correct accepts   | 65            | 65            |
| Wrong accepts     | 7             | 7             |
| Correct rejects   | 5             | 5             |
| False accepts     | 19            | 19            |
| False rejects     | 0             | 0             |
| Top-1 correctness | 61/72 (84.7%) | 62/72 (86.1%) |
| Accepted          | 91            | 91            |
| Rejected          | 5             | 5             |

## Local↔remote comparison

| Measure                               | Value                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Top-1 agreement                       | 93/96 (96.9%)                                                            |
| Full-ranking agreement                | 81/96 (84.4%)                                                            |
| Top-3 chunk-set agreement             | 87/96 (90.6%)                                                            |
| Accept/reject agreement               | 96/96 (100.0%)                                                           |
| Threshold flips                       | 0                                                                        |
| New remote false accepts              | 0                                                                        |
| New remote false rejects              | 0                                                                        |
| Resolved local errors                 | mein-konto-v1-dev-031, mein-konto-v1-dev-064                             |
| Introduced remote errors              | mein-konto-v1-dev-068                                                    |
| Score delta \|Δ\|                     | min 0.000047, mean 0.003018, median 0.002595, p95 0.008272, max 0.012231 |
| Score delta signed range              | -0.012231 … 0.009753                                                     |
| Top score within 0.02 below threshold | local 4, remote 2                                                        |
| Top score within ±0.02 of threshold   | local 4, remote 2                                                        |
| Top score within 0.02 above threshold | local 0, remote 0                                                        |
| Remote repeatability                  | bit-identical 96/96, ranking stable 96/96                                |

## Latency

| Measure                    | Value   |
| -------------------------- | ------- |
| Remote cold call           | 782 ms  |
| Remote warm p50            | 266 ms  |
| Remote warm p95            | 368 ms  |
| Remote warm p99            | 691 ms  |
| Remote warm max            | 888 ms  |
| Remote warm calls measured | 191     |
| Local cold                 | 1704 ms |
| Local warm mean            | 11 ms   |

Latency was measured from a development machine, not from the deployment target. It bounds nothing about production and is recorded as an observation only.

## Provider errors

| Class             | Count |
| ----------------- | ----- |
| Total             | 0     |
| 401 unauthorized  | 0     |
| 403 forbidden     | 0     |
| 429 rate limited  | 0     |
| 5xx server error  | 0     |
| Timeout           | 0     |
| Transport failure | 0     |
| Other HTTP        | 0     |
| Invalid payload   | 0     |

## Individual disagreements

23 disagreement record(s). Each is listed individually below; none is represented only by a summary percentage.

### mein-konto-v1-dev-031 — top-1 disagreement

- **Query type:** paraphrased
- **Expected evidence:** account-faq:wie-kann-ich-den-manufactum-newsletter-abonnieren:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-010
- **Local:** Top-1 mein-konto:v1:chunk-011
- **Remote:** Top-1 mein-konto:v1:chunk-010
- **Scores:** local 0.915473 vs remote 0.920304
- **Interpretation:** The remote arm reaches the labelled chunk where the local arm does not.

### mein-konto-v1-dev-031 — expected-evidence correctness resolved

- **Query type:** paraphrased
- **Expected evidence:** account-faq:wie-kann-ich-den-manufactum-newsletter-abonnieren:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-010
- **Local:** Top-1 mein-konto:v1:chunk-011 (incorrect)
- **Remote:** Top-1 mein-konto:v1:chunk-010 (correct)
- **Scores:** local 0.915473 vs remote 0.920304
- **Interpretation:** The remote arm reaches the labelled evidence where the local arm does not.

### mein-konto-v1-dev-031 — top-3 order difference

- **Query type:** paraphrased
- **Expected evidence:** account-faq:wie-kann-ich-den-manufactum-newsletter-abonnieren:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-010
- **Local:** mein-konto:v1:chunk-011 > mein-konto:v1:chunk-010 > mein-konto:v1:chunk-001
- **Remote:** mein-konto:v1:chunk-010 > mein-konto:v1:chunk-011 > mein-konto:v1:chunk-001
- **Scores:** local mein-konto:v1:chunk-011=0.915473 > mein-konto:v1:chunk-010=0.915323 > mein-konto:v1:chunk-001=0.876213 | remote mein-konto:v1:chunk-010=0.920304 > mein-konto:v1:chunk-011=0.919496 > mein-konto:v1:chunk-001=0.878182
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-033 — top-3 order difference

- **Query type:** paraphrased
- **Expected evidence:** account-faq:wie-kann-ich-mich-vom-manufactum-newsletter-abmelden:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-011
- **Local:** mein-konto:v1:chunk-011 > mein-konto:v1:chunk-010 > mein-konto:v1:chunk-009
- **Remote:** mein-konto:v1:chunk-011 > mein-konto:v1:chunk-009 > mein-konto:v1:chunk-010
- **Scores:** local mein-konto:v1:chunk-011=0.877899 > mein-konto:v1:chunk-010=0.847779 > mein-konto:v1:chunk-009=0.847187 | remote mein-konto:v1:chunk-011=0.877036 > mein-konto:v1:chunk-009=0.845795 > mein-konto:v1:chunk-010=0.843892
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-036 — top-3 order difference

- **Query type:** paraphrased
- **Expected evidence:** account-faq:wie-kann-ich-mein-kundenkonto-loeschen:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-012
- **Local:** mein-konto:v1:chunk-012 > mein-konto:v1:chunk-011 > mein-konto:v1:chunk-006
- **Remote:** mein-konto:v1:chunk-012 > mein-konto:v1:chunk-006 > mein-konto:v1:chunk-011
- **Scores:** local mein-konto:v1:chunk-012=0.913283 > mein-konto:v1:chunk-011=0.838812 > mein-konto:v1:chunk-006=0.835156 | remote mein-konto:v1:chunk-012=0.911024 > mein-konto:v1:chunk-006=0.837260 > mein-konto:v1:chunk-011=0.835949
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-041 — top-3 chunk-set difference

- **Query type:** short
- **Expected evidence:** account-faq:ich-moechte-mein-passwort-aendern-was-kann-ich-tun:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-005
- **Local:** local-only mein-konto:v1:chunk-002
- **Remote:** remote-only mein-konto:v1:chunk-004
- **Scores:** local mein-konto:v1:chunk-005=0.898461 > mein-konto:v1:chunk-006=0.875657 > mein-konto:v1:chunk-002=0.829476 | remote mein-konto:v1:chunk-005=0.898247 > mein-konto:v1:chunk-006=0.874684 > mein-konto:v1:chunk-004=0.832936
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-049 — top-3 chunk-set difference

- **Query type:** conversational
- **Expected evidence:** account-faq:wie-kann-ich-mich-bei-manufactum-registrieren:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-001
- **Local:** local-only mein-konto:v1:chunk-005
- **Remote:** remote-only mein-konto:v1:chunk-003
- **Scores:** local mein-konto:v1:chunk-001=0.877938 > mein-konto:v1:chunk-010=0.848721 > mein-konto:v1:chunk-005=0.844016 | remote mein-konto:v1:chunk-001=0.881349 > mein-konto:v1:chunk-010=0.849641 > mein-konto:v1:chunk-003=0.840307
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-051 — top-3 chunk-set difference

- **Query type:** conversational
- **Expected evidence:** account-faq:wo-finde-ich-meine-kundennummer:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-003
- **Local:** local-only mein-konto:v1:chunk-001
- **Remote:** remote-only mein-konto:v1:chunk-007
- **Scores:** local mein-konto:v1:chunk-003=0.922870 > mein-konto:v1:chunk-012=0.851103 > mein-konto:v1:chunk-001=0.823151 | remote mein-konto:v1:chunk-003=0.920422 > mein-konto:v1:chunk-012=0.845934 > mein-konto:v1:chunk-007=0.822483
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-057 — top-3 order difference

- **Query type:** conversational
- **Expected evidence:** account-faq:wie-funktioniert-die-mit-mir-geteilte-wunschliste:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-009
- **Local:** mein-konto:v1:chunk-001 > mein-konto:v1:chunk-010 > mein-konto:v1:chunk-008
- **Remote:** mein-konto:v1:chunk-001 > mein-konto:v1:chunk-008 > mein-konto:v1:chunk-010
- **Scores:** local mein-konto:v1:chunk-001=0.862702 > mein-konto:v1:chunk-010=0.862525 > mein-konto:v1:chunk-008=0.860591 | remote mein-konto:v1:chunk-001=0.864925 > mein-konto:v1:chunk-008=0.861287 > mein-konto:v1:chunk-010=0.860566
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-064 — top-1 disagreement

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:wie-kann-ich-meine-e-mail-adresse-aendern:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-004
- **Local:** Top-1 mein-konto:v1:chunk-001
- **Remote:** Top-1 mein-konto:v1:chunk-004
- **Scores:** local 0.852430 vs remote 0.859130
- **Interpretation:** The remote arm reaches the labelled chunk where the local arm does not.

### mein-konto-v1-dev-064 — expected-evidence correctness resolved

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:wie-kann-ich-meine-e-mail-adresse-aendern:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-004
- **Local:** Top-1 mein-konto:v1:chunk-001 (incorrect)
- **Remote:** Top-1 mein-konto:v1:chunk-004 (correct)
- **Scores:** local 0.852430 vs remote 0.859130
- **Interpretation:** The remote arm reaches the labelled evidence where the local arm does not.

### mein-konto-v1-dev-064 — top-3 chunk-set difference

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:wie-kann-ich-meine-e-mail-adresse-aendern:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-004
- **Local:** local-only mein-konto:v1:chunk-006
- **Remote:** remote-only mein-konto:v1:chunk-005
- **Scores:** local mein-konto:v1:chunk-001=0.852430 > mein-konto:v1:chunk-004=0.851308 > mein-konto:v1:chunk-006=0.844319 | remote mein-konto:v1:chunk-004=0.859130 > mein-konto:v1:chunk-001=0.846972 > mein-konto:v1:chunk-005=0.846877
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-068 — top-1 disagreement

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:kann-ich-meine-merkliste-mit-anderen-teilen:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-008
- **Local:** Top-1 mein-konto:v1:chunk-008
- **Remote:** Top-1 mein-konto:v1:chunk-009
- **Scores:** local 0.824138 vs remote 0.823612
- **Interpretation:** The remote arm loses the labelled chunk the local arm reaches.

### mein-konto-v1-dev-068 — expected-evidence correctness regressed

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:kann-ich-meine-merkliste-mit-anderen-teilen:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-008
- **Local:** Top-1 mein-konto:v1:chunk-008 (correct)
- **Remote:** Top-1 mein-konto:v1:chunk-009 (incorrect)
- **Scores:** local 0.824138 vs remote 0.823612
- **Interpretation:** The remote arm loses labelled evidence the local arm reaches.

### mein-konto-v1-dev-068 — top-3 order difference

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:kann-ich-meine-merkliste-mit-anderen-teilen:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-008
- **Local:** mein-konto:v1:chunk-008 > mein-konto:v1:chunk-009 > mein-konto:v1:chunk-007
- **Remote:** mein-konto:v1:chunk-009 > mein-konto:v1:chunk-008 > mein-konto:v1:chunk-007
- **Scores:** local mein-konto:v1:chunk-008=0.824138 > mein-konto:v1:chunk-009=0.823823 > mein-konto:v1:chunk-007=0.801085 | remote mein-konto:v1:chunk-009=0.823612 > mein-konto:v1:chunk-008=0.823524 > mein-konto:v1:chunk-007=0.798450
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-069 — top-3 chunk-set difference

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:wie-funktioniert-die-mit-mir-geteilte-wunschliste:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-009
- **Local:** local-only mein-konto:v1:chunk-010
- **Remote:** remote-only mein-konto:v1:chunk-001
- **Scores:** local mein-konto:v1:chunk-008=0.855740 > mein-konto:v1:chunk-011=0.855238 > mein-konto:v1:chunk-010=0.847739 | remote mein-konto:v1:chunk-008=0.865493 > mein-konto:v1:chunk-011=0.854738 > mein-konto:v1:chunk-001=0.850136
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-070 — top-3 chunk-set difference

- **Query type:** ambiguous_answerable
- **Expected evidence:** account-faq:wie-kann-ich-den-manufactum-newsletter-abonnieren:evidence:primary
- **Expected chunk:** mein-konto:v1:chunk-010
- **Local:** local-only mein-konto:v1:chunk-002
- **Remote:** remote-only mein-konto:v1:chunk-001
- **Scores:** local mein-konto:v1:chunk-010=0.877495 > mein-konto:v1:chunk-011=0.870317 > mein-konto:v1:chunk-002=0.847259 | remote mein-konto:v1:chunk-010=0.873025 > mein-konto:v1:chunk-011=0.867311 > mein-konto:v1:chunk-001=0.843801
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-076 — top-3 chunk-set difference

- **Query type:** hard_negative
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** local-only mein-konto:v1:chunk-008
- **Remote:** remote-only mein-konto:v1:chunk-001
- **Scores:** local mein-konto:v1:chunk-003=0.850419 > mein-konto:v1:chunk-012=0.825369 > mein-konto:v1:chunk-008=0.802657 | remote mein-konto:v1:chunk-003=0.852580 > mein-konto:v1:chunk-012=0.824021 > mein-konto:v1:chunk-001=0.799024
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-086 — top-3 chunk-set difference

- **Query type:** hard_negative
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** local-only mein-konto:v1:chunk-001
- **Remote:** remote-only mein-konto:v1:chunk-003
- **Scores:** local mein-konto:v1:chunk-012=0.889371 > mein-konto:v1:chunk-002=0.830520 > mein-konto:v1:chunk-001=0.823826 | remote mein-konto:v1:chunk-012=0.888647 > mein-konto:v1:chunk-002=0.827409 > mein-konto:v1:chunk-003=0.819477
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-092 — material score difference near threshold

- **Query type:** irrelevant
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** top score 0.796867 (rejected)
- **Remote:** top score 0.791367 (rejected)
- **Scores:** |Δ| 0.005500 within ±0.02 of the threshold
- **Interpretation:** The accept decision did not change here, but a drift of this size this close to the threshold is what a flip would look like on a different query.

### mein-konto-v1-dev-093 — top-3 chunk-set difference

- **Query type:** irrelevant
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** local-only mein-konto:v1:chunk-003
- **Remote:** remote-only mein-konto:v1:chunk-009
- **Scores:** local mein-konto:v1:chunk-008=0.796815 > mein-konto:v1:chunk-007=0.794013 > mein-konto:v1:chunk-003=0.781411 | remote mein-konto:v1:chunk-008=0.797153 > mein-konto:v1:chunk-007=0.792829 > mein-konto:v1:chunk-009=0.779030
- **Interpretation:** The grounding context handed downstream differs, although Top-1 and the accept decision may not.

### mein-konto-v1-dev-096 — top-3 order difference

- **Query type:** irrelevant
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** mein-konto:v1:chunk-007 > mein-konto:v1:chunk-009 > mein-konto:v1:chunk-008
- **Remote:** mein-konto:v1:chunk-007 > mein-konto:v1:chunk-008 > mein-konto:v1:chunk-009
- **Scores:** local mein-konto:v1:chunk-007=0.785756 > mein-konto:v1:chunk-009=0.780263 > mein-konto:v1:chunk-008=0.778325 | remote mein-konto:v1:chunk-007=0.776929 > mein-konto:v1:chunk-008=0.772682 > mein-konto:v1:chunk-009=0.771541
- **Interpretation:** The same chunks are returned in a different order below Top-1; the grounding set is unchanged.

### mein-konto-v1-dev-096 — material score difference near threshold

- **Query type:** irrelevant
- **Expected evidence:** — (unanswerable)
- **Expected chunk:** — (unanswerable)
- **Local:** top score 0.785756 (rejected)
- **Remote:** top score 0.776929 (rejected)
- **Scores:** |Δ| 0.008827 within ±0.02 of the threshold
- **Interpretation:** The accept decision did not change here, but a drift of this size this close to the threshold is what a flip would look like on a different query.

## Verdict

**PASS WITH OBSERVATIONS**

- labelled Top-1 changed on 3 query/queries with no net loss (2 resolved, 1 regressed)
- 9 query/queries where the returned Top-3 chunk set differs
- 6 query/queries where the Top-3 order differs with the same chunks
- the served remote revision is unpinnable (no X-Repo-Commit header) — an accepted limitation carried from Gate 3
- remote latency is roughly an order of magnitude above the local arm and is measured from this machine, not from the deployment target

Retrieval behaviour, not geometric similarity, is the acceptance criterion here. No cosine threshold is defined or implied by this experiment.

## Accepted limitations

- **The served remote revision is unpinnable.** The endpoint returns no `X-Repo-Commit` header (Gate 3), so there is no way to detect the provider serving different weights between runs. Every result here is valid for the weights served during this run and nothing more.
- **Latency is not production latency.** It was measured from a development machine over a residential path, not from the deployment target.
- **Only the query side was swapped.** The passage embeddings remain the local int8 ONNX artifacts. This experiment says nothing about re-embedding the corpus remotely.
- **One document, one language.** The corpus is the twelve `mein-konto` v1 chunks in German. Nothing here generalises to a second source or a second language.

## Reproduction

```
npx tsx scripts/evaluate-rag-remote-query-embedding.ts
```

Requires `HF_TOKEN` and `DATABASE_URL` in `.env`. The script is read-only against the database and writes only this report and its results artifact.
