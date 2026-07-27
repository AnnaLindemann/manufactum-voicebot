# RAG experiment report: canonical FAQ question-only Top-3 reranking

- **Experiment ID:** `canonical-question-top3-reranking`
- **Status:** `experiment_rejected`
- **Date:** 2026-07-27
- **Commit under test:** `18fafd15a08fb4bce75de892d2953077b6a5067a` (branch `main`, identical to `origin/main`)
- **Results artifact:** [`docs/evaluation/rag-canonical-question-top3-reranking-experiment-results.json`](evaluation/rag-canonical-question-top3-reranking-experiment-results.json)
- **Script:** `scripts/evaluate-rag-canonical-question-top3-reranking.ts`
- **Test:** `tests/unit/rag-canonical-question-top3-reranking.test.ts`

This is an offline, ranking-only development experiment. It changed no production code, no runtime
behaviour, no routes, no database data, no active chunks, no stored embeddings, and no accepted
evaluation artifact. It proposes no threshold and no production activation.

## 1. Scope and preflight

| Preflight check                   | Expected                                   | Observed         | Result |
| --------------------------------- | ------------------------------------------ | ---------------- | ------ |
| Branch                            | `main`                                     | `main`           | pass   |
| `HEAD`                            | `18fafd15a08fb4bce75de892d2953077b6a5067a` | same             | pass   |
| `origin/main` (after `git fetch`) | `18fafd15a08fb4bce75de892d2953077b6a5067a` | same             | pass   |
| Tracked changes                   | none                                       | none             | pass   |
| Untracked scope                   | `dialfire/` only                           | `dialfire/` only | pass   |

`dialfire/` was left untouched: it was neither inspected, modified, staged, nor committed. It is
reported by name only.

Frozen inputs (SHA-256 recorded in the artifact and re-verified after the run):

| Input                                                                                                   | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json`                                  | `523464871475a6c921d7de7b75beb9591aea7261d8719dc4a180117fb1d82dbc` |
| `docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json`                   | `303ed62a9b263c45ef4c203ee25da07f019c804c6c24a0d5e23c2ef6340fcf1f` |
| `docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json`              | `828aa3913a9cf13a9127f3e6505a0c5dc024e9d58efc7cbe382d028b9bab1d69` |
| `docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json` (accepted control) | `13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d` |

The historical 52-query dataset was not read. No held-out data was created or inspected. The frozen
96-query development dataset (72 answerable, 24 unanswerable) was read only.

## 2. Control reproduction

The accepted control is the passage brand-context canonicalization representation:

```
Marke: Manufactum

Frage: {Q}

Antwort: {A}
```

where `Q` and `A` are the source FAQ question and answer with standalone case-insensitive
occurrences of "Manufactum" removed and whitespace normalized, so each control passage contains
exactly one standalone "Manufactum". The rejected duplicated-question candidate from the current
HEAD was **not** used as control.

The script re-embedded all 12 control passages from the live active chunk set and re-ran the full
first-stage ranking over all 12 chunks for all 96 queries.

| Control check                               | Expected                      | Reproduced         |
| ------------------------------------------- | ----------------------------- | ------------------ |
| Active FAQ chunks                           | 12                            | 12                 |
| Control representation SHA-256 per chunk    | matches accepted artifact     | 12/12 match        |
| Control embedding input hash per chunk      | matches accepted artifact     | 12/12 match        |
| Standalone "Manufactum" per control passage | exactly 1                     | 12/12              |
| First-stage rank order per query            | identical to accepted control | 96/96 identical    |
| Max absolute per-chunk score delta          | 0                             | `0`                |
| Top-1 correct (answerable)                  | 68/72                         | 68/72              |
| Recall@1                                    | 0.944444                      | 0.944444           |
| Recall@3                                    | 1.000000                      | 1.000000           |
| MRR                                         | 0.969907                      | 0.969907           |
| Incorrect control Top-1 queries             | 015, 067, 068, 069            | 015, 067, 068, 069 |

Control reproduction is exact. Candidate evaluation was therefore permitted to proceed.

## 3. Exact candidate implementation

The single independent variable is one fixed canonical-question-only reranking stage applied over
the control Top-3.

1. Run the accepted first-stage control retrieval over all 12 passages (unchanged).
2. Preserve the exact first-stage Top-3 membership per query.
3. For each of the three candidate chunks, construct the transient reranker text

   ```
   Marke: Manufactum

   Frage: {Q}
   ```

   where `Q` is the identical canonicalized source FAQ question already used by the accepted control
   passage (parsed from the accepted control representation, so it cannot drift).

4. Embed that text transiently with the same pinned embedding implementation and the normal passage
   prefix `passage: `. Nothing is persisted.
5. Reuse the unchanged query embedding (byte-identical query input hash for 96/96 queries).
6. Reorder only the three first-stage candidates by descending query-to-reranker-text cosine, with
   ascending first-stage rank as the deterministic tie-breaker.
7. Ranks 4–12 stay exactly as the first stage produced them; no chunk outside the first-stage Top-3
   can enter the candidate Top-3.

The 12 reranker texts (uniform, one Marke line, one Frage line, no Antwort line, exactly one
standalone "Manufactum" each):

| Chunk       | Reranker text (after `Marke: Manufactum\n\n`)                |
| ----------- | ------------------------------------------------------------ |
| `chunk-001` | `Frage: Wie kann ich mich bei registrieren?`                 |
| `chunk-002` | `Frage: Welche Vorteile bietet mir ein Konto?`               |
| `chunk-003` | `Frage: Wo finde ich meine Kundennummer?`                    |
| `chunk-004` | `Frage: Wie kann ich meine E-Mail-Adresse ändern?`           |
| `chunk-005` | `Frage: Ich möchte mein Passwort ändern, was kann ich tun?`  |
| `chunk-006` | `Frage: Ich habe mein Passwort vergessen, was kann ich tun?` |
| `chunk-007` | `Frage: Wie nutze ich die Merkliste?`                        |
| `chunk-008` | `Frage: Kann ich meine Merkliste mit anderen teilen?`        |
| `chunk-009` | `Frage: Wie funktioniert die mit mir geteilte Wunschliste?`  |
| `chunk-010` | `Frage: Wie kann ich den Newsletter abonnieren?`             |
| `chunk-011` | `Frage: Wie kann ich mich vom Newsletter abmelden?`          |
| `chunk-012` | `Frage: Wie kann ich mein Kundenkonto löschen?`              |

Preserved invariants: frozen 96-query dataset and ordering, 72/24 answerable split, query texts and
query embeddings, the 12 first-stage chunks and passage embeddings, first-stage ranking direction,
deterministic first-stage tie-breaking, embedding model and pinned revision
`ae61bf0193ce3851dc8a45147e459b04ed783d8a`, tokenizer, mean pooling, L2 normalization, 384
dimensions, and the E5 prefixes. No labels, keywords, synonyms, paraphrases, intent descriptions,
`faqIntentId`, `expectedEvidenceId`, query-derived text, or query-specific rules entered
construction; the reranker builder consumes `originalQuestion` only.

## 4. Control and candidate metrics

| Metric (72 answerable) | Control  | Candidate | Delta     |
| ---------------------- | -------- | --------- | --------- |
| Top-1 correct          | 68/72    | 58/72     | −10       |
| Recall@1               | 0.944444 | 0.805556  | −0.138888 |
| Recall@3               | 1.000000 | 1.000000  | 0.000000  |
| MRR                    | 0.969907 | 0.895833  | −0.074074 |

Recall@3 remaining at 1.000000 was verified from the per-query results, not hard-coded: candidate
Top-3 membership equals control Top-3 membership for all 96 queries, and
`controlRecallAt3 === candidateRecallAt3` holds for every answerable query.

## 5. Complete corrections and regressions

**Corrections (3):** net −10.

| Query | Text                                             | Intent                                              | Expected rank |
| ----- | ------------------------------------------------ | --------------------------------------------------- | ------------- |
| 015   | "Was bringt mir ein Kundenkonto bei Manufactum?" | `welche-vorteile-bietet-mir-ein-konto`              | 2 → 1         |
| 068   | "Liste an Familie senden"                        | `kann-ich-meine-merkliste-mit-anderen-teilen`       | 2 → 1         |
| 069   | "Fremde Wunschliste bei Manufactum nutzen"       | `wie-funktioniert-die-mit-mir-geteilte-wunschliste` | 2 → 1         |

**Regressions (13):** previously correct answerable queries that lost Top-1.

| Query | Text                                                                        | Type                 | Intent                  | Expected rank | Top-1 chunk |
| ----- | --------------------------------------------------------------------------- | -------------------- | ----------------------- | ------------- | ----------- |
| 010   | "Wie kann ich den Manufactum Newsletter abonnieren?"                        | exact                | `newsletter-abonnieren` | 1 → 2         | 010 → 011   |
| 013   | "Wo kann ich ein Kundenkonto bei Manufactum anlegen?"                       | paraphrased          | `registrieren`          | 1 → 3         | 001 → 012   |
| 014   | "Wie erstelle ich online ein neues Kundenkonto?"                            | paraphrased          | `registrieren`          | 1 → 3         | 001 → 012   |
| 021   | "Wie vergebe ich ein neues Passwort für mein Konto?"                        | paraphrased          | `passwort-aendern`      | 1 → 2         | 005 → 006   |
| 025   | "Wie speichere ich Artikel für später auf der Merkliste?"                   | paraphrased          | `merkliste`             | 1 → 2         | 007 → 008   |
| 031   | "Wie melde ich mich für den Manufactum Newsletter an?"                      | paraphrased          | `newsletter-abonnieren` | 1 → 2         | 010 → 011   |
| 043   | "Merkliste nutzen"                                                          | short                | `merkliste`             | 1 → 2         | 007 → 008   |
| 046   | "Manufactum Newsletter abonnieren"                                          | short                | `newsletter-abonnieren` | 1 → 2         | 010 → 011   |
| 055   | "Ich will mir Produkte für später merken, wie läuft das?"                   | conversational       | `merkliste`             | 1 → 2         | 007 → 009   |
| 058   | "Ich möchte den Newsletter von Manufactum bekommen, wie melde ich mich an?" | conversational       | `newsletter-abonnieren` | 1 → 2         | 010 → 011   |
| 061   | "Konto neu anlegen"                                                         | ambiguous_answerable | `registrieren`          | 1 → 2         | 001 → 002   |
| 065   | "Kennwort im Konto ändern"                                                  | ambiguous_answerable | `passwort-aendern`      | 1 → 2         | 005 → 004   |
| 070   | "Newsletter im Konto aktivieren"                                            | ambiguous_answerable | `newsletter-abonnieren` | 1 → 2         | 010 → 011   |

**Change accounting**

| Quantity                                                   | Value                              |
| ---------------------------------------------------------- | ---------------------------------- |
| Corrections                                                | 3                                  |
| Regressions                                                | 13                                 |
| Net corrections                                            | −10                                |
| Expected-rank changes (answerable)                         | 16                                 |
| Top-1 evidence changes (all queries)                       | 25 (17 answerable, 8 unanswerable) |
| Queries whose Top-3 order changed                          | 49                                 |
| Neutral ranking changes (order changed, outcome unchanged) | 33                                 |
| Answerable queries still not Top-1 correct                 | 14                                 |

The three dominant regression clusters are `newsletter-abonnieren` (5 of 6 answerable queries lost
Top-1 to chunk-011 "vom Newsletter abmelden"), `merkliste` (3 lost Top-1 to chunk-008/009), and
`registrieren` (3 lost Top-1, two of them dropping to rank 3 behind chunk-012 "Kundenkonto
löschen"). Stripping the answer text removes the disambiguating signal that separates
subscribe/unsubscribe and create/delete pairs, whose questions are lexically near-identical.

## 6. Detailed analysis of 015, 067, 068, and 069

### 015 — "Was bringt mir ein Kundenkonto bei Manufactum?" (paraphrased)

- Expected chunk: `chunk-002` (`welche-vorteile-bietet-mir-ein-konto`)
- Control Top-3 (first-stage passage cosine): 1 `chunk-012` 0.900026, 2 `chunk-002` **0.899823**, 3 `chunk-001` 0.895381
- Candidate Top-3 (reranker question cosine): 1 `chunk-002` **0.884654**, 2 `chunk-012` 0.878259, 3 `chunk-001` 0.846344
- Expected rank 2 → 1; competing chunks `chunk-012`, `chunk-001`
- Control margin (expected − Top-1): −0.000203. Reranker margin (expected − best competitor): +0.006395
- **Outcome: corrected.** The control loss was a 0.0002 near-tie against the "Kundenkonto löschen"
  answer text; the question-only view separates "Vorteile eines Kontos" from "Konto löschen" cleanly.

### 067 — "Liste für später" (ambiguous_answerable)

- Expected chunk: `chunk-007` (`wie-nutze-ich-die-merkliste`)
- Control Top-3: 1 `chunk-009` 0.841670, 2 `chunk-008` 0.839863, 3 `chunk-007` **0.826958**
- Candidate Top-3: 1 `chunk-008` 0.816948, 2 `chunk-009` 0.811352, 3 `chunk-007` **0.797381**
- Expected rank 3 → 3; competing chunks `chunk-009`, `chunk-008`
- Control margin: −0.014712. Reranker margin: −0.019567 (worse)
- **Outcome: unresolved, with a deteriorated margin.** The generic phrase "Liste für später" carries
  no signal that distinguishes "Merkliste nutzen" from sharing (`chunk-008`) or a shared Wunschliste
  (`chunk-009`). Removing the answer text removes the only place where the actual usage description
  lived, so the expected chunk falls further behind. Reranking swapped the two wrong chunks with each
  other and left the correct one at rank 3.

### 068 — "Liste an Familie senden" (ambiguous_answerable)

- Expected chunk: `chunk-008` (`kann-ich-meine-merkliste-mit-anderen-teilen`)
- Control Top-3: 1 `chunk-009` 0.825624, 2 `chunk-008` **0.822119**, 3 `chunk-007` 0.803029
- Candidate Top-3: 1 `chunk-008` **0.819818**, 2 `chunk-009` 0.812237, 3 `chunk-007` 0.805557
- Expected rank 2 → 1; competing chunks `chunk-009`, `chunk-007`
- Control margin: −0.003505. Reranker margin: +0.007581
- **Outcome: corrected.** "senden / teilen" matches the question "Kann ich meine Merkliste mit
  anderen teilen?" more strongly than the shared-Wunschliste question once the answer bodies — which
  both discuss lists and recipients — are dropped.

### 069 — "Fremde Wunschliste bei Manufactum nutzen" (ambiguous_answerable)

- Expected chunk: `chunk-009` (`wie-funktioniert-die-mit-mir-geteilte-wunschliste`)
- Control Top-3: 1 `chunk-008` 0.900058, 2 `chunk-009` **0.885387**, 3 `chunk-007` 0.877845
- Candidate Top-3: 1 `chunk-009` **0.878371**, 2 `chunk-008` 0.869443, 3 `chunk-007` 0.850359
- Expected rank 2 → 1; competing chunks `chunk-008`, `chunk-007`
- Control margin: −0.014671. Reranker margin: +0.008928
- **Outcome: corrected.** This is the inverse confusion of 068: "fremde Wunschliste" aligns with the
  "mit mir geteilte Wunschliste" question, while `chunk-008`'s answer text about sharing one's own
  Merkliste had been dominating in the control.

The 008/009 pair therefore behaves as hoped in both directions (068 and 069 corrected), but the
generic-Merkliste case (067) is not addressable by question-only similarity, and the same
transformation that separated 008 from 009 pulls other Merkliste queries away from `chunk-007`.

## 7. Same-intent stability

All answerable queries sharing an intent with 015, 067, 068, or 069.

### `account-faq:welche-vorteile-bietet-mir-ein-konto` (target 015)

| Query | Type                 | Expected rank | Top-1 correct | Reranker margin (Top1−Top2) |
| ----- | -------------------- | ------------- | ------------- | --------------------------- |
| 002   | exact                | 1 → 1         | true → true   | 0.073436                    |
| 016   | paraphrased          | 1 → 1         | true → true   | 0.002764                    |
| 038   | short                | 1 → 1         | true → true   | 0.058640                    |
| 050   | conversational       | 1 → 1         | true → true   | 0.039566                    |
| 062   | ambiguous_answerable | 1 → 1         | true → true   | 0.021203                    |

No regressions, no expected-rank deterioration. Query 016 is the thinnest surviving margin (0.0028).

### `account-faq:wie-nutze-ich-die-merkliste` (target 067)

| Query | Type           | Expected rank | Top-1 correct    | Reranker margin | Classification |
| ----- | -------------- | ------------- | ---------------- | --------------- | -------------- |
| 007   | exact          | 1 → 1         | true → true      | 0.030685        | unchanged      |
| 025   | paraphrased    | 1 → 2         | true → **false** | 0.015795        | **regression** |
| 026   | paraphrased    | 1 → 1         | true → true      | 0.009004        | unchanged      |
| 043   | short          | 1 → 2         | true → **false** | 0.010317        | **regression** |
| 055   | conversational | 1 → 2         | true → **false** | 0.000131        | **regression** |

Three Top-1 regressions and three margin deteriorations inside the intent that the 067 target was
supposed to help. 055 additionally sits at an effectively degenerate 0.000131 reranker margin.

### `account-faq:kann-ich-meine-merkliste-mit-anderen-teilen` (target 068)

| Query | Type           | Expected rank | Top-1 correct | Reranker margin |
| ----- | -------------- | ------------- | ------------- | --------------- |
| 008   | exact          | 1 → 1         | true → true   | 0.057899        |
| 027   | paraphrased    | 1 → 1         | true → true   | 0.037944        |
| 028   | paraphrased    | 1 → 1         | true → true   | 0.043203        |
| 044   | short          | 1 → 1         | true → true   | 0.031472        |
| 056   | conversational | 1 → 1         | true → true   | 0.046321        |

No regressions, no margin deterioration.

### `account-faq:wie-funktioniert-die-mit-mir-geteilte-wunschliste` (target 069)

| Query | Type           | Expected rank | Top-1 correct | Reranker margin |
| ----- | -------------- | ------------- | ------------- | --------------- |
| 009   | exact          | 1 → 1         | true → true   | 0.044124        |
| 029   | paraphrased    | 1 → 1         | true → true   | 0.027627        |
| 030   | paraphrased    | 1 → 1         | true → true   | 0.029111        |
| 045   | short          | 1 → 1         | true → true   | 0.025510        |
| 057   | conversational | 1 → 1         | true → true   | 0.023470        |

No regressions, no margin deterioration.

Summary: the two sharing/Wunschliste intents are stable, but the Merkliste intent absorbs three Top-1
regressions, and the intents outside the target set (`newsletter-abonnieren`, `registrieren`,
`passwort-aendern`) carry the remaining ten.

## 8. First-stage versus reranker-score interpretation

The two score spaces are stored separately in the artifact (`firstStageRanking[].score` and
`rerankerScoresForTop3[].rerankerScore`) and are never averaged, summed, or otherwise combined.

- **First stage:** cosine between the query embedding and the full canonical passage embedding
  (brand + question + answer). Top-1 scores across the 96 queries span 0.7759–0.9395.
- **Second stage:** cosine between the same query embedding and the transient
  brand-plus-question-only text embedding. Top-3 reranker scores span 0.7859–0.9177, and the
  selected Top-1 reranker score is on average 0.0138 below the first-stage Top-1 passage score.

These spaces are not interchangeable. No shared threshold was computed, and the reranker cosine must
not be compared against the accepted production threshold. A higher reranker cosine is **not**
evidence of better calibration — shorter texts simply shift the cosine distribution. The candidate
is judged only on ranks, corrections, regressions, Recall@1, Recall@3, and MRR.

## 9. Acceptance-gate table

| Gate                               | Requirement                             | Observed     | Result   |
| ---------------------------------- | --------------------------------------- | ------------ | -------- |
| Recall@1                           | > 0.944444                              | 0.805556     | **FAIL** |
| Recall@3                           | = 1.000000                              | 1.000000     | pass     |
| MRR                                | > 0.969907                              | 0.895833     | **FAIL** |
| Targets corrected                  | ≥ 2 of 067/068/069 Top-1 correct        | 2 (068, 069) | pass     |
| Net corrections                    | corrections − regressions ≥ 1           | 3 − 13 = −10 | **FAIL** |
| Top-1 regressions                  | ≤ 1 previously correct answerable query | 13           | **FAIL** |
| Uniform reranker                   | fixed rule applied to all 12 chunks     | true         | pass     |
| Top-3 membership                   | unchanged first-stage Top-3             | true (96/96) | pass     |
| Retrieval/embedding invariants     | all preserved                           | true         | pass     |
| No labels/rules/enrichment/leakage | none present                            | true         | pass     |

Six of ten gates pass; four fail.

## 10. Experiment decision

```
experiment_rejected
```

The fixed canonical-question-only reranker does exactly what it was hypothesised to do on the
008/009 Wunschliste/Merkliste-sharing confusion (068 and 069 corrected, 015 corrected as a bonus),
but the same transformation destroys the answer-text signal that separates the newsletter
subscribe/unsubscribe pair, the register/delete pair, and the Merkliste usage/sharing pair. Three
corrections against thirteen regressions leaves Recall@1 and MRR well below the accepted control.

Recall@3 is structurally unchanged by construction — the candidate reorders a fixed membership set —
so it carries no evidence for or against the candidate. This experiment proposes no threshold, no
production activation, and no baseline promotion. The accepted control remains the reference.

## 11. Verification

| Check           | Command                                                                   | Result                     |
| --------------- | ------------------------------------------------------------------------- | -------------------------- |
| Focused test    | `npx vitest run tests/unit/rag-canonical-question-top3-reranking.test.ts` | 12/12 passed               |
| Typecheck       | `npm run typecheck`                                                       | passed                     |
| Lint            | `npm run lint`                                                            | passed                     |
| Formatting      | `npm run format:check`                                                    | passed                     |
| Full test suite | `npm test`                                                                | 29 files, 417 tests passed |
| Build           | `npm run build`                                                           | passed                     |
| Whitespace      | `git diff --check -- . ':!dialfire/'`                                     | clean                      |

Focused test coverage: accepted control reproduction, exact reranker-text construction, absence of
answer text, uniform application over all 12 chunks, unchanged query inputs, unchanged first-stage
ranking and Top-3 membership, deterministic reranking and tie-breaking, score-space separation,
independent metric recomputation, independent recomputation of corrections/regressions/neutral
changes, the predetermined decision gates, and the absence of target-ID-specific branches (the four
target IDs appear only in reporting-only constants and in no construction or ranking function).
