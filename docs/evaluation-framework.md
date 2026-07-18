# Evaluation Framework

## Purpose

This document defines how every implemented feature is evaluated before it is accepted.

A roadmap phase is not considered complete until it successfully passes the applicable evaluation criteria defined in this document.

Implementation completion and code compilation are not sufficient for acceptance.

---

# Level 1 — Technical Validation

Goal:

Verify that the implementation works correctly from a technical perspective.

Checks:

- Project builds successfully.
- Tests pass.
- Backend starts successfully.
- API endpoints respond correctly.
- Dialfire integration works.
- No unhandled exceptions.
- Logging is available.
- Error handling is implemented.

Acceptance:

PASS / FAIL

---

# Level 2 — Information Validation

Goal:

Verify that the assistant provides correct information.

Checks:

- Product name matches API.
- Price matches API.
- Availability matches API.
- Store information matches API.
- Reservation information matches API.
- No fabricated data.
- Unknown information is never invented.

Primary KPI:

Hallucination Rate = 0
for all information originating from APIs.

Acceptance:

PASS / FAIL

---

# Level 3 — Conversation Validation

Goal:

Verify conversation quality.

Checks:

- Correct intent detection.
- Appropriate follow-up questions.
- No unnecessary questions.
- Natural dialogue.
- Concise answers.
- No repetitive responses.

Acceptance:

PASS / FAIL

---

# Level 4 — Task Success Validation

Goal:

Verify that the customer successfully completes the requested task.

Examples:

- Product Search
- Product Availability
- Store Search
- Reservation
- Reservation Cancellation
- FAQ

Primary KPI:

Task Success Rate

Acceptance:

PASS / FAIL

---

# Level 5 — Customer Experience

Goal:

Evaluate overall user experience.

Checks:

- Conversation feels natural.
- Customer receives the expected answer.
- Human transfer only when necessary.
- Acceptable conversation duration.

Acceptance:

PASS / FAIL

---

# Level 6 — Cost Validation

Goal:

Ensure operational costs remain acceptable.

Metrics:

- Cost per conversation.
- Cost per scenario.
- Input tokens.
- Output tokens.
- Average latency.
- Number of API calls.
- Number of LLM calls.

Acceptance:

PASS / FAIL

---

# Level 7 — Performance Validation

Goal:

Measure system performance.

Metrics:

- API response time.
- Backend processing time.
- LLM response time.
- End-to-end response time.

Acceptance:

PASS / FAIL

---

# Level 8 — RAG Validation

(Used after the RAG system is implemented.)

Checks:

- Correct document retrieved.
- Correct document version retrieved.
- Correct chunks retrieved.
- Source attribution available.
- No outdated information.

Acceptance:

PASS / FAIL

---

# Acceptance Rule

Every roadmap phase must include exactly one report: the **Implementation Report**, created from
`implementation-report-template.md`.

There is no separate Evaluation Report document. Evaluation is recorded as a section inside the
Implementation Report. "Implementation Report" and "Evaluation Report" refer to the same artifact.

A phase is accepted only if all **applicable** evaluation levels pass successfully.

Known limitations must be documented before acceptance.

## Applicability

Evaluation levels apply only when the phase produces the behavior they measure.

Levels 2 to 8 measure customer-facing conversation behavior, information correctness, cost, and
retrieval quality. They are **not applicable** until customer-facing scenarios exist, which begins
with Dialfire integration in Phase 8.

Before that point:

- Level 1 (Technical Validation) applies, limited to what the phase actually builds;
- Levels 2 to 8 are recorded as "not applicable" with a one-line reason;
- a level is never recorded as PASS when it was not exercised.

Phase 0 specifically evaluates Level 1 only. It has no API calls, no conversation, no retrieval, and
no cost surface to measure.
