# RAG Evaluation Dataset Specification

## Scope

This document specifies two future independent RAG retrieval-evaluation datasets:

- development dataset;
- held-out validation dataset.

It is only a dataset specification. It does not create query examples, dataset JSON files, retrieval
experiments, production retrieval behavior, thresholds, routes, ingestion, embeddings, chunks, active RAG
data, answer generation, or Dialfire assets.

The existing frozen dataset `tests/fixtures/rag/retrieval-evaluation-dataset.json` is historical only.
It contains `52` queries and has already influenced the baseline checkpoint, rejected brand-token
normalization, rejected FAQ-question gate, rejected FAQ-question reranker, and unrecoverable-query
diagnosis. It must therefore be used only as a historical regression set, never as a development or
independent validation set, and never as a tuning set.

## Dataset Purposes

### Development Dataset

Purpose:

- evaluate and compare candidate retrieval designs during development;
- calibrate candidate-owned thresholds, ranking recipes, answerability gates, and error handling;
- diagnose retrieval failures before selecting a frozen candidate.

Permitted use:

- repeated offline evaluation;
- error analysis;
- tuning and rule changes for candidate designs;
- ablation studies;
- candidate rejection before held-out evaluation.

Prohibited use:

- reporting final independent quality;
- replacing the historical regression set;
- deriving held-out labels, queries, or category distributions from observed development failures;
- changing source labels after candidate results are known unless an independent label review records
  that the original label was invalid.

### Held-Out Validation Dataset

Purpose:

- provide one independent acceptance check for one frozen retrieval candidate;
- estimate whether the candidate generalizes beyond the historical and development sets.

Permitted use:

- exactly one scoring run for one frozen candidate package;
- acceptance or rejection of that candidate according to this specification;
- post-decision reporting of aggregate results and failure classes.

Prohibited use:

- threshold tuning;
- prompt, rule, normalization, reranking, query-rewrite, chunking, ingestion, or production retrieval
  changes based on held-out results;
- iterative error-driven changes;
- selecting between multiple candidates after inspecting held-out outcomes;
- validating any later candidate after the held-out version has been opened.

## Dataset Scopes

### Immediate Scope For The Next Controlled Chunk Experiment

The immediate dataset versions are scoped to the currently approved immutable FAQ corpus:

- source: `mein-konto`;
- document type: `account-faq`;
- document version: active immutable version `1`;
- active FAQ items: `12`;
- current active chunks: `12`, used only as the accepted baseline retrieval structure and not as stable
  dataset ground truth.

Immediate development dataset target: `96` queries.

| Type                   | Count | Answerability |
| ---------------------- | ----: | ------------- |
| `exact`                |    12 | answerable    |
| `paraphrased`          |    24 | answerable    |
| `short`                |    12 | answerable    |
| `conversational`       |    12 | answerable    |
| `ambiguous_answerable` |    12 | answerable    |
| `hard_negative`        |    18 | unanswerable  |
| `irrelevant`           |     6 | unanswerable  |

Immediate held-out validation dataset target: `80` queries.

| Type                   | Count | Answerability |
| ---------------------- | ----: | ------------- |
| `exact`                |    12 | answerable    |
| `paraphrased`          |    24 | answerable    |
| `short`                |    12 | answerable    |
| `conversational`       |     6 | answerable    |
| `ambiguous_answerable` |     6 | answerable    |
| `hard_negative`        |    15 | unanswerable  |
| `irrelevant`           |     5 | unanswerable  |

Immediate distribution rules:

- answerable queries must cover all `12` FAQ intents;
- every FAQ intent must have one `exact` query in each dataset;
- development must have exactly `6` answerable queries per FAQ intent;
- held-out must have exactly `5` answerable queries for each of the `12` FAQ intents;
- no FAQ intent may have more than `2` `paraphrased` queries in a dataset;
- no FAQ intent may have more than `1` `short`, `1` `conversational`, or `1`
  `ambiguous_answerable` query in a dataset;
- hard negatives must be spread across at least `9` different nearest confusable FAQ intents in
  development and at least `8` in held-out;
- irrelevant queries have `faqCategory: null` and are not assigned to an FAQ intent.

These immediate sizes are large enough to cover every currently approved FAQ intent and the known
failure classes without allowing an excessive cluster of near-duplicate paraphrases around one intent.
They are intentionally smaller than the later multi-category portfolio targets because only one approved
source exists today.

### Later Multi-Category Scope

Later expanded dataset versions apply only after additional source-registry categories have approved
immutable source documents and active document versions.

Coverage units:

- `account-faq`;
- `ordering`;
- `payment`;
- `shipping`;
- `click-and-collect`;
- `returns`;
- `complaints`;
- `vouchers`;
- `customer-card`;
- `store-services`;
- `store-contact`;
- `customer-service-faq`.

The portfolio targets below are later targets, not an immediate freeze requirement:

- development dataset: `240` queries, with `180` answerable and `60` unanswerable;
- held-out validation dataset: `144` queries, with `108` answerable and `36` unanswerable.

Later development query-type counts:

| Type                   | Count | Answerability |
| ---------------------- | ----: | ------------- |
| `exact`                |    24 | answerable    |
| `paraphrased`          |    72 | answerable    |
| `short`                |    36 | answerable    |
| `conversational`       |    36 | answerable    |
| `ambiguous_answerable` |    12 | answerable    |
| `hard_negative`        |    48 | unanswerable  |
| `irrelevant`           |    12 | unanswerable  |

Later held-out query-type counts:

| Type                   | Count | Answerability |
| ---------------------- | ----: | ------------- |
| `exact`                |    12 | answerable    |
| `paraphrased`          |    36 | answerable    |
| `short`                |    24 | answerable    |
| `conversational`       |    24 | answerable    |
| `ambiguous_answerable` |    12 | answerable    |
| `hard_negative`        |    24 | unanswerable  |
| `irrelevant`           |    12 | unanswerable  |

When the number of approved categories changes, quotas are preserved by this deterministic allocation:

1. Filter to categories with approved immutable source documents and active versions.
2. Allocate answerable queries evenly across approved categories.
3. Allocate one `exact` query per stable FAQ item only when the category's item count permits it; any
   remaining answerable quota is allocated in this order: `paraphrased`, `short`, `conversational`,
   `ambiguous_answerable`.
4. Enforce a maximum of `2` same-type answerable queries per stable FAQ intent.
5. Allocate `hard_negative` queries across approved categories by round-robin over nearest confusable
   evidence.
6. Keep `irrelevant` queries category-free with `faqCategory: null`.
7. Allocate any remainder by lexical category order, then by stable FAQ intent order.
8. Recompute Manufactum-token quotas after the final answerable/unanswerable counts are known.

Expanded versions must document the approved categories, excluded categories, blocked reasons, category
counts, query-type counts, answerability counts, and brand-token counts in the manifest.

## Query-Type Rules

`exact` queries must be close to the canonical FAQ question for the labeled source evidence. They are
allowed to normalize punctuation or casing, but must not introduce a new meaning.

`paraphrased` queries must preserve the source intent while using different wording, syntax, or
synonyms. They should include both easy paraphrases and semantically distant but still label-valid
paraphrases.

`short` queries must resemble terse caller input. They may omit verbs, articles, or full context, but
must still be labelable by an independent reviewer from the approved source.

`conversational` queries must resemble spoken German customer phrasing, including polite forms,
first-person wording, and natural voice-assistant wording. They must remain concise enough for the
retrieval query path.

`ambiguous_answerable` queries may contain mild ambiguity, but the labeled source evidence must still
be the only clearly acceptable answer under the approved source set. The ambiguity must be documented in
`labelRationale`.

`hard_negative` queries must be unanswerable by the active RAG FAQ content while being lexically or
semantically close to an approved FAQ category. They should include adjacent intents, API-only facts,
transactional state, unsupported actions, and near-confusions between FAQ evidence units.

`irrelevant` queries must be clearly outside the approved RAG FAQ surface and must not be answerable
from any active source.

## Manufactum Brand Token

Both datasets must include queries with and without the standalone brand token `Manufactum`.

Required distribution:

- target `25%` of all queries contain standalone token `Manufactum`;
- target `25%` of answerable queries contain standalone token `Manufactum`;
- target `25%` of unanswerable queries contain standalone token `Manufactum`;
- if a count is not divisible by `4`, use nearest-integer rounding with halves rounded up and record the
  exact count in the manifest.

Immediate exact counts:

- development: `24` total with brand token, including `18` answerable and `6` unanswerable;
- held-out: `20` total with brand token, including `15` answerable and `5` unanswerable.

Later portfolio exact counts:

- development: `60` total with brand token, including `45` answerable and `15` unanswerable;
- held-out: `36` total with brand token, including `27` answerable and `9` unanswerable.

Brand-token placement must vary across query types, FAQ intents, and categories. It must not be
concentrated only in account, registration, or newsletter queries. `containsManufactumToken` is always
computed by the evaluator from standalone token matching and is never trusted as a manual label.

## Candidate-Independent Ground Truth

Immutable query labels must describe stable semantic evidence, not candidate-specific chunks.

Stable answerable ground truth is based on:

- `sourceUrl`;
- `documentKey`;
- `documentVersion`;
- stable FAQ item or intent identifier;
- immutable supporting source span;
- SHA-256 hash of the normalized supporting source span;
- acceptable semantic evidence identifiers.

The immutable query label must not contain `expectedChunkKey`, `chunkIndex`, `chunkHash`, or any other
candidate chunk boundary identifier. Those values belong in candidate-specific mapping artifacts.

Stable evidence fields:

- `faqIntentId`: stable FAQ intent identifier required for answerable queries;
- `expectedEvidenceId`: canonical semantic evidence identifier required for answerable queries;
- `acceptableEvidenceIds`: all semantic evidence identifiers that fully answer the query;
- `supportingSourceSpanHash`: SHA-256 of the normalized minimal source span sufficient to justify the
  answer;
- `supportingSourceSpanSelector`: stable source selector or structural path to the evidence inside the
  immutable document version;
- `semanticEvidenceRationale`: short explanation of why this evidence answers the query.

Invariants:

- `faqIntentId` is required for answerable queries and must be `null` for `irrelevant` queries;
- `expectedEvidenceId` is required only for answerable queries and must be `null` for unanswerable
  queries;
- `expectedEvidenceId` must be included in `acceptableEvidenceIds`;
- `acceptableEvidenceIds` must be non-empty for answerable queries and empty for unanswerable queries;
- `faqIntentId`, `expectedEvidenceId`, and every ID in `acceptableEvidenceIds` must belong to the same
  `faqCategory`, `documentKey`, and `documentVersion` for answerable queries;
- one FAQ intent may have one or more semantic evidence IDs only if that relationship is explicitly
  declared in the frozen evidence inventory;
- every answerable evidence identifier must belong to the declared `documentKey` and `documentVersion`;
- `supportingSourceSpanHash` is required for answerable queries;
- expected semantic evidence is required only for answerable queries;
- `candidateEvidenceMappings` must cover every answerable evidence unit before a candidate can be
  scored;
- `faqCategory` may be `null` only for `irrelevant` queries;
- for `hard_negative` queries, `faqCategory` must equal `nearestFaqCategory`;
- for `hard_negative` queries, `faqIntentId` must be `null` and `nearestFaqIntentId` must identify the
  nearest confusable FAQ intent;
- `nearestConfusableEvidence` for `hard_negative` queries must belong to `nearestFaqIntentId`.

## Candidate Chunk Mapping And Scoring

Every frozen chunking candidate must provide a deterministic mapping from candidate chunks to the stable
semantic evidence units before scoring starts.

Candidate mapping artifact requirements:

- candidate package identifier and Git commit;
- chunking recipe identifier and SHA-256-relevant inputs;
- retrieval configuration, including Top-K and threshold if the candidate uses them;
- one row per candidate chunk;
- candidate chunk key and chunk hash;
- source document key and version;
- evidence coverage list with evidence IDs and coverage status;
- reviewer or deterministic mapper identity;
- mapping artifact format version.

Coverage status values:

- `full`: the chunk contains all source evidence needed for the evidence ID;
- `partial`: the chunk contains only part of the evidence and cannot alone be scored correct;
- `none`: the chunk does not support the evidence ID.

Deterministic scoring:

- an answerable query is a correct accept when the candidate accepts an answer and the selected chunk has
  `full` coverage for at least one ID in `acceptableEvidenceIds`;
- an answerable query is a wrong accept when the candidate accepts an answer but the selected chunk has
  no `full` coverage for any acceptable evidence ID;
- an answerable query is an answerable reject when the candidate abstains;
- an unanswerable query is a correct reject when the candidate abstains;
- an unanswerable query is a false accept when the candidate accepts any chunk or answer;
- Recall@K is correct when at least one retrieved candidate chunk in the candidate's own Top-K has
  `full` coverage for an acceptable evidence ID;
- if a candidate retrieves multiple chunks for answer generation, the scoring manifest must define
  before evaluation whether correctness is based on selected Top-1, selected answer-support chunk, or
  any accepted cited chunk. That rule is part of the frozen candidate package.

The accepted baseline may use its existing chunk keys through a baseline mapping artifact, but future
chunking candidates are evaluated through evidence coverage, not direct chunk-key equality.

## Label Schema

Future dataset files must use one object per query with these required fields:

- `id`: stable unique ID within the dataset version;
- `dataset`: `development` or `held_out_validation`;
- `datasetVersion`: immutable semantic dataset version;
- `language`: `de`;
- `query`: German user query text;
- `queryType`: one of `exact`, `paraphrased`, `short`, `conversational`,
  `ambiguous_answerable`, `hard_negative`, `irrelevant`;
- `answerability`: `answerable` or `unanswerable`;
- `faqCategory`: one of the approved coverage units or `null` for irrelevant queries;
- `faqIntentId`: stable FAQ intent ID for answerable queries, otherwise `null`;
- `nearestFaqCategory`: required for `hard_negative`, optional for `irrelevant`, otherwise `null`;
- `nearestFaqIntentId`: required for `hard_negative`, optional for `irrelevant`, otherwise `null`;
- `nearestConfusableEvidence`: required for `hard_negative`, otherwise `null`;
- `containsManufactumToken`: computed boolean recorded by the dataset builder;
- `sourceUrl`: source URL for answerable queries, otherwise `null`;
- `documentKey`: immutable document key for answerable queries, otherwise `null`;
- `documentVersion`: immutable document version for answerable queries, otherwise `null`;
- `sourceContentHash`: immutable document content hash for answerable queries, otherwise `null`;
- `expectedEvidenceId`: stable semantic evidence ID for answerable queries, otherwise `null`;
- `acceptableEvidenceIds`: non-empty list for answerable queries, empty list for unanswerable queries;
- `supportingSourceSpanSelector`: stable source selector or structural path for answerable queries,
  otherwise `null`;
- `supportingSourceSpanHash`: SHA-256 of the normalized minimal source span for answerable queries,
  otherwise `null`;
- `semanticEvidenceRationale`: short explanation of why the expected semantic evidence answers an
  answerable query, otherwise `null`;
- `provenanceQuoteHash`: SHA-256 of the minimal source text used by reviewers to justify an answerable
  label, otherwise `null`;
- `unanswerableScopeHash`: SHA-256 of the frozen source-registry revision plus evidence-inventory or
  corpus-scope manifest used to justify an unanswerable label, otherwise `null`;
- `labelRationale`: short rationale for why the query is answerable or unanswerable;
- `labeler`: labeler identifier;
- `reviewer`: independent reviewer identifier;
- `reviewMethod`: human review, separate-agent review, or human-plus-agent review;
- `reviewStatus`: `approved`, `rejected`, or `needs_revision`;
- `createdAt`: ISO 8601 timestamp;
- `approvedAt`: ISO 8601 timestamp or `null`.

The corresponding manifest must include:

- dataset version;
- dataset scope;
- source registry revision;
- approved source document versions;
- evidence inventory SHA-256;
- dataset JSON SHA-256;
- leakage-check method and result;
- brand-token computation method;
- query-type, answerability, category, and brand-token counts;
- per-intent distribution counts by `faqIntentId`;
- reviewer identities and review method summary.

For unanswerable queries, provenance is the frozen source-registry revision and evidence-inventory or
corpus-scope SHA-256 that define what the RAG corpus can answer. Unanswerable labels must not invent a
supporting quote. For `hard_negative` queries, `faqCategory` and `nearestFaqCategory` must match, and
`nearestFaqIntentId` must identify the nearest intent inside that category. `nearestConfusableEvidence`
must belong to `nearestFaqIntentId`. For `irrelevant` queries, `faqCategory` is `null`;
`nearestFaqCategory` and `nearestFaqIntentId` may be set only when useful for analysis and must not
affect answerability.

The frozen evidence inventory must declare the relationship between `faqCategory`, `faqIntentId`,
`expectedEvidenceId`, and `acceptableEvidenceIds`. Validators and manifests must use `faqIntentId` for
per-intent distribution rules. The specification does not assume that one evidence ID equals one FAQ
intent unless the frozen evidence inventory explicitly declares a one-to-one relationship for that
source version.

## Independent Label Review

Dataset authoring and review must be operationally separated.

Procedure:

1. A labeler drafts queries from approved source documents without running or viewing candidate retrieval
   results.
2. The labeler records provenance and rationale for every item.
3. A reviewer who is not the original labeler validates query type, answerability, expected semantic
   evidence, acceptable semantic evidence, category, nearest confusable evidence, and brand-token
   computation using only approved source documents, immutable evidence inventory, and dataset metadata.
4. The reviewer records identity, review method, reviewed artifact SHA-256, and approval timestamp.
5. Disagreements are resolved by editing or rejecting the item before freeze.
6. Any item whose answerability depends on price, stock, reservation state, order state, or rapidly
   changing availability is rejected because those facts must come from real-time APIs, not RAG.
7. The final manifest records reviewer identity, review method, approval timestamp, source registry
   revision, active document versions, evidence inventory SHA-256, and dataset SHA-256.

Acceptable arrangements:

- two different humans;
- one human labeler and a separate-agent reviewer, recorded as separate-agent review;
- one separate-agent labeler and a human reviewer;
- human-plus-agent review when the human reviewer remains accountable for approval.

Separate-agent review is operational separation, not a claim of statistical independence from the model
family used in retrieval. No query may enter either dataset with only self-review by the original
labeler.

## Leakage Prevention

The three sets have separate roles:

- historical regression set: preserves known behavior and past canaries;
- development dataset: permits tuning and repeated experiments;
- held-out validation dataset: one-time independent acceptance check.

Rules:

- independently authored wording for the same semantic FAQ intent is permitted and required in the
  immediate `mein-konto` development and held-out datasets;
- no query text may be duplicated across historical, development, and held-out sets after Unicode
  normalization, case folding, punctuation normalization, whitespace normalization, and removal of the
  standalone `Manufactum` token;
- no query may be a trivial lexical variant of a query in another set, including inflection-only,
  word-order-only, punctuation-only, politeness-only, or synonym-swap-only variants;
- no query may be a template-derived variant where only slot values, the brand token, or a small synonym
  set differ from another set;
- no query may differ from another set only by adding or removing the standalone `Manufactum` token;
- no held-out query may use independently reviewed near-duplicate wording from a historical or
  development query;
- historical results may be used only to detect regressions, not to tune a candidate;
- labelers and reviewers must not inspect candidate retrieval outputs while authoring or reviewing
  held-out items;
- held-out authoring must happen before the frozen candidate is selected;
- held-out aggregate results must not be opened until the candidate package is frozen.

Operational near-duplicate review method:

1. Build a review table for historical, development, and held-out candidate queries using only query
   text, query type, dataset, semantic intent ID, and source category.
2. Normalize query text with Unicode normalization, case folding, punctuation removal, whitespace
   normalization, stopword-light comparison, and standalone `Manufactum` removal.
3. Flag exact normalized duplicates, high token-overlap pairs, shared ordered bigram/trigram patterns,
   and repeated authoring templates.
4. Review every flagged cross-dataset pair manually or by a separate-agent reviewer without candidate
   retrieval results.
5. Approve pairs only when the wording is independently authored and materially different, even if the
   semantic FAQ intent is the same.
6. Record the leakage-review method, reviewer identity, rejected duplicates, and final leakage-check
   SHA-256 in the dataset manifest.

## Held-Out Lifecycle

One held-out dataset version is used for one frozen candidate.

Lifecycle:

1. Author, review, freeze, and hash-record the held-out version before selecting the candidate.
2. Freeze the candidate package.
3. Verify historical, development, and held-out hashes.
4. Run held-out scoring exactly once.
5. Record aggregate metrics and the accept/reject decision before inspecting per-query held-out
   failures.
6. After per-query inspection, permanently retire that held-out version as independent validation.
7. The retired held-out version may inform later development only after a new independent held-out
   version has been authored, reviewed, frozen, and hash-recorded.
8. The retired held-out version must never validate another candidate.

If a held-out run rejects a candidate, the next development cycle may discuss the retired held-out
failure classes, but final validation of any later candidate requires a new held-out version. The new
held-out version must pass the same leakage checks against the historical set, development set, and all
retired held-out versions.

## Held-Out Custody

Held-out artifacts are sealed until candidate freeze. People or agents implementing, tuning, comparing,
or selecting retrieval candidates must not inspect held-out query text, labels, provenance, or per-query
metadata before the candidate package is frozen.

Custody rules:

- held-out authors and reviewers may inspect held-out content for authoring and review, but must not use
  candidate retrieval outputs;
- candidate implementers and selectors may see only sealed-artifact identifiers, declared aggregate
  counts, and external hash records before candidate freeze;
- the sealed held-out artifact may be opened by the designated scoring process only after candidate
  freeze;
- permitted identities or roles, access method, artifact hashes, candidate freeze time, and held-out
  opening time must be recorded in the freeze report or lockfile;
- aggregate held-out results must be recorded before per-query held-out inspection;
- any per-query inspection retires that held-out version as independent validation.

This custody model provides operational separation only. It must not be described as statistical
independence when the actual authoring, review, or scoring arrangement does not provide that stronger
property.

## Freezing And SHA-256

Each dataset version must be immutable after freeze.

Freeze requirements:

- dataset JSON and manifest are formatted deterministically;
- every item has `reviewStatus: approved`;
- declared counts match this specification;
- every answerable item resolves to immutable semantic evidence, not candidate chunk keys;
- every candidate-specific chunk mapping artifact is separate from the dataset label and has its own
  externally recorded SHA-256;
- historical/development/held-out leakage checks pass;
- dataset JSON hashes and evidence-inventory hashes may be recorded in the manifest;
- the manifest's own full-file SHA-256 is recorded only in a separate freeze report or external lockfile;
- a candidate mapping artifact's own full-file SHA-256 is recorded only in the candidate freeze report
  or external lockfile;
- no artifact is required to contain its own full-file hash;
- the SHA-256 values are recorded in a freeze report or lockfile before any evaluation run;
- evaluation scripts must verify historical and development SHA-256 values before and after scoring;
- evaluation scripts must verify held-out SHA-256 before the one held-out scoring run and after scoring
  without rerunning held-out retrieval;
- evaluators verify all hashes against the external frozen record, not against self-embedded full-file
  hashes;
- changing any query, label, provenance field, evidence inventory field, or metadata creates a new
  dataset version and new SHA-256 values.

## Metrics

Primary metrics:

- answerable Top-1 semantic-evidence accuracy;
- answerable Recall@K under the candidate's own frozen Top-K;
- answerability precision;
- answerability recall;
- unanswerable false-positive rate;
- end-to-end correct-answer rate across all queries.

Secondary metrics:

- MRR on answerable queries;
- Top-1/Top-2 score margin distribution when the candidate exposes comparable scores;
- false accepts split by `hard_negative` and `irrelevant`;
- answerable rejection rate;
- category-level semantic-evidence Top-1 accuracy;
- query-type-level semantic-evidence Top-1 accuracy;
- brand-token and non-brand-token metric slices;
- source and document-version traceability completeness;
- evaluator determinism by repeated run with identical SHA-256 input on historical and development
  datasets only.

Held-out scoring remains one-time. Evaluator determinism must be established on historical and
development datasets before opening held-out, not by repeating the held-out run.

## Historical Semantic Overlay

The historical `52`-query fixture remains unchanged and retains its existing chunk-key-based labels and
accepted baseline artifact. To compare candidates with different chunk boundaries against the
historical regression set, a separate historical semantic-evidence overlay is required.

The overlay must:

- be keyed by historical query ID;
- contain `expectedEvidenceId` and `acceptableEvidenceIds` for answerable historical queries;
- contain unanswerable provenance through the frozen source-registry revision and evidence-inventory or
  corpus-scope SHA-256 for unanswerable historical queries;
- include `nearestFaqCategory` and `nearestConfusableEvidence` for historical hard negatives;
- be independently reviewed under the same reviewer rules as new datasets;
- be frozen and SHA-256 recorded before any candidate with different chunk boundaries is scored against
  the historical regression set;
- leave `tests/fixtures/rag/retrieval-evaluation-dataset.json` and the accepted baseline artifact
  unchanged.

For the accepted baseline, the overlay bridges each historical chunk-key label to stable semantic
evidence through the baseline mapping artifact. For any chunking candidate, the candidate's own mapping
artifact is then scored against the same overlay evidence IDs. Without the frozen overlay, only
same-boundary candidates may be compared to the historical fixture by direct chunk-key equality.

## Zero-Regression Policy

The accepted baseline is evaluated with its accepted frozen configuration. A candidate is evaluated with
its own frozen configuration, including its own Top-K, threshold, scoring rule, embedding profile, and
chunk mapping artifact.

Regression comparison is performed over the same immutable query and semantic-evidence label set.

The candidate must preserve:

- every baseline correct accept on answerable historical-regression queries;
- every baseline correct reject on unanswerable historical-regression queries;
- every development correct accept and correct reject used to select the candidate.

For answerable queries, preservation means the candidate accepts and retrieves candidate evidence with
`full` coverage for an acceptable evidence ID. For unanswerable queries, preservation means the
candidate abstains. A candidate-specific threshold or Top-K change cannot excuse a lost correct accept
or correct reject.

Any regression rejects the candidate unless an independent label review records that the original label
or baseline outcome classification was invalid.

## Acceptance And Rejection Criteria

A candidate can proceed to held-out validation only if, on the historical and development datasets:

- zero-regression policy passes;
- answerable Top-1 semantic-evidence accuracy improves or remains equal while another primary metric
  improves;
- Recall@K does not decrease under each system's own frozen Top-K;
- unanswerable false-positive rate decreases or remains equal;
- source traceability is complete for every accepted answerable query;
- no answer is accepted from inactive document versions;
- evaluator determinism has been verified on historical and development datasets;
- all relevant non-mutating validation checks pass.

Held-out tolerance formulas:

- `clamp(x, n) = min(max(x, 0), n)`.
- `roundHalfUp(x) = floor(x + 0.5)`.
- For Top-1 accuracy, let `nDevAnswerable` be development answerable query count, `cDevTop1` be
  development correct Top-1 count, `nHeldAnswerable` be held-out answerable query count, and
  `cHeldTop1` be held-out correct Top-1 count.
- Projected held-out Top-1 correct count:
  `projectedTop1 = clamp(roundHalfUp(nHeldAnswerable * cDevTop1 / nDevAnswerable), nHeldAnswerable)`.
- Allowed Top-1 tolerance count for `pTop1` percentage points:
  `allowedTop1Loss = floor(nHeldAnswerable * pTop1 / 100)`.
- Final minimum held-out Top-1 correct count:
  `minHeldTop1 = clamp(projectedTop1 - allowedTop1Loss, nHeldAnswerable)`.
- Top-1 acceptance condition: `cHeldTop1 >= minHeldTop1`.
- For Recall@K, let `cDevRecallK` be development answerable queries with acceptable evidence anywhere
  in the candidate's frozen Top-K and `cHeldRecallK` be the same count on held-out.
- Projected held-out Recall@K correct count:
  `projectedRecallK = clamp(roundHalfUp(nHeldAnswerable * cDevRecallK / nDevAnswerable), nHeldAnswerable)`.
- Allowed Recall@K tolerance count for `pRecall` percentage points:
  `allowedRecallLoss = floor(nHeldAnswerable * pRecall / 100)`.
- Final minimum held-out Recall@K correct count:
  `minHeldRecallK = clamp(projectedRecallK - allowedRecallLoss, nHeldAnswerable)`.
- Recall@K acceptance condition: `cHeldRecallK >= minHeldRecallK`.
- For unanswerable false-positive rate, let `nDevUnanswerable` be development unanswerable query count,
  `fpDev` be development false accepts, `nHeldUnanswerable` be held-out unanswerable query count, and
  `fpHeld` be held-out false accepts.
- Projected held-out false-accept count:
  `projectedFalseAccepts = clamp(roundHalfUp(nHeldUnanswerable * fpDev / nDevUnanswerable), nHeldUnanswerable)`.
- Allowed false-accept tolerance count for `pFp` percentage points:
  `allowedFalseAcceptIncrease = floor(nHeldUnanswerable * pFp / 100)`.
- Final maximum held-out false-accept count:
  `maxHeldFalseAccepts = clamp(projectedFalseAccepts + allowedFalseAcceptIncrease, nHeldUnanswerable)`.
- False-positive-rate acceptance condition: `fpHeld <= maxHeldFalseAccepts`.

Immediate held-out tolerances for `80` queries:

- Top-1 accuracy uses `nDevAnswerable = 72`, `nHeldAnswerable = 60`, and `pTop1 = 5`; therefore
  `allowedTop1Loss = floor(60 * 5 / 100) = 3`.
- Recall@K uses `nDevAnswerable = 72`, `nHeldAnswerable = 60`, and `pRecall = 3`; therefore
  `allowedRecallLoss = floor(60 * 3 / 100) = 1`.
- Unanswerable false-positive rate uses `nDevUnanswerable = 24`, `nHeldUnanswerable = 20`, and
  `pFp = 5`; therefore `allowedFalseAcceptIncrease = floor(20 * 5 / 100) = 1`.

Later portfolio held-out tolerances for `144` queries:

- Top-1 accuracy uses `nDevAnswerable = 180`, `nHeldAnswerable = 108`, and `pTop1 = 5`; therefore
  `allowedTop1Loss = floor(108 * 5 / 100) = 5`.
- Recall@K uses `nDevAnswerable = 180`, `nHeldAnswerable = 108`, and `pRecall = 3`; therefore
  `allowedRecallLoss = floor(108 * 3 / 100) = 3`.
- Unanswerable false-positive rate uses `nDevUnanswerable = 60`, `nHeldUnanswerable = 36`, and
  `pFp = 5`; therefore `allowedFalseAcceptIncrease = floor(36 * 5 / 100) = 1`.

A frozen candidate is accepted on the held-out validation dataset only if:

- the held-out run is the first and only run for that held-out version and frozen candidate;
- dataset JSON, manifest, evidence inventory, and candidate mapping SHA-256 values match the external
  frozen record;
- zero-regression policy still passes on historical and development datasets;
- held-out metrics satisfy the exact allowed query-count tolerances above;
- held-out source traceability is `100%` for accepted answerable queries;
- no held-out accepted answer uses an inactive source version or candidate chunk without `full` evidence
  coverage.

The candidate is rejected if any acceptance criterion fails, if the held-out dataset was previously used
for tuning, or if any held-out result influenced the candidate before freeze.

## Experiment Stopping Rules

Development experiments stop when either:

- one candidate satisfies all pre-held-out criteria and is frozen for validation;
- three consecutive candidate families fail to improve any primary metric without regressions;
- a candidate reaches zero historical/development regressions and no remaining error class has at least
  `5` independent development examples;
- further improvement would require changing production retrieval, ingestion, active RAG data, answer
  generation, or Dialfire outside the approved experiment scope.

For a frozen candidate, held-out evaluation is run once and then stops. There is no second held-out pass
after threshold adjustment, per-query fix, rule change, reranking tweak, or determinism check.

## Frozen Candidate Procedure For Held-Out Evaluation

Before held-out evaluation:

1. Record candidate code/config/artifact identifiers, including Git commit, retrieval profile, Top-K,
   threshold, embedding profile, answer selection rule, evaluator script SHA-256, and candidate chunk
   mapping SHA-256 from the external frozen record.
2. Verify historical and development dataset SHA-256 values.
3. Run historical and development evaluation, including evaluator determinism checks.
4. Confirm the pre-held-out criteria pass.
5. Freeze the candidate package and record its SHA-256-relevant inputs.
6. Verify held-out dataset, manifest, and evidence inventory SHA-256 values against the external frozen
   record.
7. Run held-out evaluation exactly once.
8. Record aggregate held-out metrics and acceptance or rejection before inspecting per-query failures.
9. Retire the held-out version permanently after per-query inspection.
