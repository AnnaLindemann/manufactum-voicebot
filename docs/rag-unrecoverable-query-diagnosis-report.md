# RAG Unrecoverable Query Diagnosis Report

## Scope

Diagnostic phase only. No production retrieval behavior, thresholds, routes, ingestion, stored
embeddings, chunks, active RAG data, answer generation, Dialfire assets, or frozen evaluation artifacts
were changed.

Generated artifact:

- `docs/evaluation/rag-unrecoverable-query-diagnosis-results.json`

Dedicated script:

- `scripts/diagnose-rag-unrecoverable-queries.ts`

The rejected FAQ-question gate, FAQ-question Top-3 reranker, and brand-token normalization remain
rejected and were not implemented in production.

## Methodology

The diagnostic script reads:

- the frozen dataset;
- the accepted baseline evaluation artifact;
- the rejected brand-token, FAQ-gate, and FAQ-reranker artifacts;
- the active `mein-konto` chunks from PostgreSQL.

For each target query it computes a read-only full ranking over all 12 active chunks using exactly the
existing baseline retrieval recipe:

- original query text;
- existing E5 query embedding recipe with `query:`;
- existing stored passage embeddings created with `passage:`;
- existing cosine similarity over normalized embeddings;
- no normalization, reranking, threshold change, or database write.

## Target Summary

| Query ID     | Expected chunk | Expected rank | Expected score | Top-1 chunk | Top-1 score | Top-1 gap | Rank-3 gap |
| ------------ | -------------- | ------------: | -------------: | ----------- | ----------: | --------: | ---------: |
| `para-003-a` | `chunk-003`    |             4 |       0.860018 | `chunk-001` |    0.883672 |  0.023654 |   0.005970 |
| `para-006-a` | `chunk-006`    |             4 |       0.861415 | `chunk-001` |    0.884550 |  0.023135 |   0.000737 |
| `para-012-b` | `chunk-012`    |             4 |       0.858158 | `chunk-001` |    0.881850 |  0.023692 |   0.023067 |

All three expected chunks are rank 4, just outside the baseline Top-3.

## `para-003-a`

Query: `Wo kann ich meine Manufactum Kundennummer nachsehen?`

Expected chunk: `mein-konto:v1:chunk-003`

Expected canonical Frage: `Wo finde ich meine Kundennummer?`

Relevant answer: `Ihre Kundennummer finden Sie innerhalb Ihres Kontos im Bereich „Persönliche Angaben“ sowie oben rechts auf Ihrer Rechnung.`

Baseline Top-3:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.883672 |
|    2 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.883096 |
|    3 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.865988 |

Full ranking:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.883672 |
|    2 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.883096 |
|    3 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.865988 |
|    4 | `chunk-003` | Wo finde ich meine Kundennummer?                      | 0.860018 |
|    5 | `chunk-007` | Wie nutze ich die Merkliste?                          | 0.813325 |
|    6 | `chunk-012` | Wie kann ich mein Kundenkonto löschen?                | 0.808748 |
|    7 | `chunk-008` | Kann ich meine Merkliste mit anderen teilen?          | 0.799040 |
|    8 | `chunk-009` | Wie funktioniert die mit mir geteilte Wunschliste?    | 0.784306 |
|    9 | `chunk-006` | Ich habe mein Passwort vergessen, was kann ich tun?   | 0.781362 |
|   10 | `chunk-002` | Welche Vorteile bietet mir ein Konto?                 | 0.776141 |
|   11 | `chunk-005` | Ich möchte mein Passwort ändern, was kann ich tun?    | 0.756808 |
|   12 | `chunk-004` | Wie kann ich meine E-Mail-Adresse ändern?             | 0.752040 |

Same-label comparison:

| Query ID     | Query                                                | Expected rank | Expected score | Top-1       | Top-1 correct |
| ------------ | ---------------------------------------------------- | ------------: | -------------: | ----------- | ------------- |
| `exact-003`  | Wo finde ich meine Kundennummer?                     |             1 |       0.935719 | `chunk-003` | yes           |
| `para-003-a` | Wo kann ich meine Manufactum Kundennummer nachsehen? |             4 |       0.860018 | `chunk-001` | no            |
| `para-003-b` | An welcher Stelle steht meine Kundennummer?          |             1 |       0.913945 | `chunk-003` | yes           |

Label validity: valid. The expected chunk directly answers where the customer number can be found.
The registration and newsletter chunks do not reasonably answer the query. The query is not materially
ambiguous.

Likely diagnosis: misleading semantic overlap from brand-bearing competing chunks, with an embedding
model sensitivity to the standalone `Manufactum` token.

Evidence:

- all baseline Top-3 chunks have `Manufactum` in the canonical question;
- the exact query and the non-brand paraphrase for the same label succeed;
- rejected brand-token normalization moved this query to `chunk-003`.

Counterevidence:

- the query contains the strong term `Kundennummer`, which should have favored the expected chunk.

Confidence: high for brand-token displacement; medium for model limitation.

Falsifier: a broader set of brand-containing Kundennummer variants ranking `chunk-003` first under
baseline retrieval would weaken this diagnosis.

## `para-006-a`

Query: `Was mache ich, wenn ich mein Manufactum Passwort vergessen habe?`

Expected chunk: `mein-konto:v1:chunk-006`

Expected canonical Frage: `Ich habe mein Passwort vergessen, was kann ich tun?`

Relevant answer: `Falls Sie Ihr Passwort vergessen haben, klicken Sie bitte im Login-Bereich oder hier auf den Link Passwort vergessen ...`

Baseline Top-3:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.884550 |
|    2 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.863152 |
|    3 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.862152 |

Full ranking:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.884550 |
|    2 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.863152 |
|    3 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.862152 |
|    4 | `chunk-006` | Ich habe mein Passwort vergessen, was kann ich tun?   | 0.861415 |
|    5 | `chunk-005` | Ich möchte mein Passwort ändern, was kann ich tun?    | 0.817953 |
|    6 | `chunk-007` | Wie nutze ich die Merkliste?                          | 0.812319 |
|    7 | `chunk-002` | Welche Vorteile bietet mir ein Konto?                 | 0.802858 |
|    8 | `chunk-012` | Wie kann ich mein Kundenkonto löschen?                | 0.794188 |
|    9 | `chunk-008` | Kann ich meine Merkliste mit anderen teilen?          | 0.792529 |
|   10 | `chunk-009` | Wie funktioniert die mit mir geteilte Wunschliste?    | 0.788631 |
|   11 | `chunk-003` | Wo finde ich meine Kundennummer?                      | 0.781104 |
|   12 | `chunk-004` | Wie kann ich meine E-Mail-Adresse ändern?             | 0.752009 |

Same-label comparison:

| Query ID     | Query                                                                       | Expected rank | Expected score | Top-1       | Top-1 correct |
| ------------ | --------------------------------------------------------------------------- | ------------: | -------------: | ----------- | ------------- |
| `exact-006`  | Ich habe mein Passwort vergessen, was kann ich tun?                         |             1 |       0.919936 | `chunk-006` | yes           |
| `para-006-a` | Was mache ich, wenn ich mein Manufactum Passwort vergessen habe?            |             4 |       0.861415 | `chunk-001` | no            |
| `para-006-b` | Wie bekomme ich wieder Zugriff, wenn mir mein Passwort nicht mehr einfällt? |             1 |       0.872834 | `chunk-006` | yes           |

Label validity: valid. The expected chunk directly answers forgotten-password recovery. Registration
and newsletter chunks do not answer the request.

Likely diagnosis: misleading semantic overlap from brand-bearing competing chunks. A weaker secondary
factor is the broad phrasing `Was mache ich`, but the query still has enough password-reset signal.

Evidence:

- baseline Top-3 is again `Manufactum` registration/newsletter content;
- exact and non-brand paraphrase variants for the same expected chunk succeed;
- rejected brand-token normalization moved this query to `chunk-006`;
- expected chunk is only `0.000737` below rank 3, so this is a narrow Top-3 miss.

Counterevidence:

- `Passwort vergessen` appears directly in the query and should strongly match the expected chunk.

Confidence: high for brand-token displacement; low for missing semantic signal.

Falsifier: multiple brand-containing forgotten-password variants ranking `chunk-006` first under
baseline retrieval would weaken the diagnosis.

## `para-012-b`

Query: `Kann ich mein Manufactum Konto löschen lassen?`

Expected chunk: `mein-konto:v1:chunk-012`

Expected canonical Frage: `Wie kann ich mein Kundenkonto löschen?`

Relevant answer: `Wenden Sie sich bitte per E-Mail an unseren Customer Service. Für eine schnelle Bearbeitung schreiben Sie bitte als Betreff „Löschung Kundenkonto“.`

Baseline Top-3:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.881850 |
|    2 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.881697 |
|    3 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.881225 |

Full ranking:

| Rank | Chunk       | Canonical Frage                                       |    Score |
| ---: | ----------- | ----------------------------------------------------- | -------: |
|    1 | `chunk-001` | Wie kann ich mich bei Manufactum registrieren?        | 0.881850 |
|    2 | `chunk-011` | Wie kann ich mich vom Manufactum Newsletter abmelden? | 0.881697 |
|    3 | `chunk-010` | Wie kann ich den Manufactum Newsletter abonnieren?    | 0.881225 |
|    4 | `chunk-012` | Wie kann ich mein Kundenkonto löschen?                | 0.858158 |
|    5 | `chunk-007` | Wie nutze ich die Merkliste?                          | 0.825966 |
|    6 | `chunk-009` | Wie funktioniert die mit mir geteilte Wunschliste?    | 0.808343 |
|    7 | `chunk-006` | Ich habe mein Passwort vergessen, was kann ich tun?   | 0.807889 |
|    8 | `chunk-002` | Welche Vorteile bietet mir ein Konto?                 | 0.807707 |
|    9 | `chunk-008` | Kann ich meine Merkliste mit anderen teilen?          | 0.806004 |
|   10 | `chunk-005` | Ich möchte mein Passwort ändern, was kann ich tun?    | 0.793843 |
|   11 | `chunk-003` | Wo finde ich meine Kundennummer?                      | 0.789873 |
|   12 | `chunk-004` | Wie kann ich meine E-Mail-Adresse ändern?             | 0.771054 |

Same-label comparison:

| Query ID     | Query                                          | Expected rank | Expected score | Top-1       | Top-1 correct |
| ------------ | ---------------------------------------------- | ------------: | -------------: | ----------- | ------------- |
| `exact-012`  | Wie kann ich mein Kundenkonto löschen?         |             1 |       0.922879 | `chunk-012` | yes           |
| `para-012-a` | Wie entferne ich mein Kundenkonto dauerhaft?   |             1 |       0.857676 | `chunk-012` | yes           |
| `para-012-b` | Kann ich mein Manufactum Konto löschen lassen? |             4 |       0.858158 | `chunk-001` | no            |

Label validity: valid, with mild wording ambiguity. `löschen lassen` sounds service-assisted, but the
expected chunk itself instructs the user to contact Customer Service, so it directly answers the query.
The competing chunks do not answer account deletion.

Likely diagnosis: misleading semantic overlap from brand-bearing competing chunks. A secondary
low-confidence factor is wording ambiguity around `löschen lassen`.

Evidence:

- baseline Top-3 is again registration/newsletter content with `Manufactum`;
- exact and non-brand deletion variants succeed;
- rejected brand-token normalization moved this query to `chunk-012`;
- the expected deletion answer is present and active.

Counterevidence:

- the query contains both `Konto` and `löschen`, which should strongly match `Kundenkonto löschen`.

Confidence: high for misleading semantic overlap; low for label ambiguity.

Falsifier: a future approved support-assisted deletion FAQ could make the label less obviously unique.

## Cross-Experiment Interpretation

The FAQ-question gate could not correct these failures because it never changes Top-1. It only scores
the already selected wrong candidate and can accept or reject it.

The Top-3 reranker could not correct them because all three expected chunks are rank 4, outside the
candidate set. It can only reorder the original three wrong candidates.

Rejected brand-token normalization recovered all three target failures:

| Query ID     | Baseline Top-1 | Normalized Top-1 |
| ------------ | -------------- | ---------------- |
| `para-003-a` | `chunk-001`    | `chunk-003`      |
| `para-006-a` | `chunk-001`    | `chunk-006`      |
| `para-012-b` | `chunk-001`    | `chunk-012`      |

This supports the brand-token displacement hypothesis. It does not justify production adoption,
because that candidate regressed other answerable queries.

Weakened or disproved hypotheses:

- the expected chunks are not missing from storage or inactive;
- the labels are not obviously wrong;
- answerability gating is not the right mechanism for these ranking misses;
- Top-3-only reranking is insufficient when the correct chunk is rank 4.

## Limitations And Overfitting Risk

Overfitting risk is now high. The same frozen 52-query dataset has been used for baseline analysis and
three rejected experiments. Further tuning against these same known failures would likely optimize for
the current labels rather than generalize.

Before another production-oriented retrieval change, the project should create:

- a development set for diagnostics and candidate iteration;
- a held-out validation set for acceptance decisions;
- enough brand-containing and non-brand paraphrases per FAQ topic to separate real improvements from
  dataset-specific fixes.

## Recommended Next Step

Smallest next experiment to consider later, not implemented here:

Run a query-ablation diagnostic for standalone brand-token sensitivity on a new development split only.
Measure whether adding/removing standalone `Manufactum` systematically displaces otherwise correct
FAQ chunks, before proposing any production retrieval candidate.
