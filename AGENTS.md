# Agent Instructions

## Scope and workflow

1. Read `README.md` and all relevant files in `docs/` before coding.
2. Implement only the explicitly requested roadmap phase.
3. Do not implement future phases or add speculative infrastructure.
4. Do not change frozen documentation without explicit approval.
5. Do not commit unless explicitly requested.
6. Follow `docs/implementation-workflow.md`.

## Documentation status

Project documentation is draft until it is explicitly marked as frozen.

When documentation is frozen:

- do not change it without explicit approval;
- raise contradictions or missing decisions before coding;
- document approved changes clearly.

## External APIs

1. Do not invent external API behavior.
2. Base API contracts only on observed and documented responses.
3. Keep raw upstream API types separate from internal domain models.
4. Validate all external input and upstream responses.
5. Store only redacted API samples, never secrets or personal data.

## Security and data

1. Keep secrets out of source code, prompts, logs, fixtures, documentation, and commits.
2. Use environment variables for credentials.
3. Minimize personal data.
4. Do not log authentication headers, API keys, or unnecessary reservation data.
5. Price, stock, availability, and reservation state must come from real-time APIs, never from RAG.

## Dialfire and conversation design

1. Keep Dialfire as the conversation layer.
2. Use phase-based dynamic prompting.
3. Do not load all conversation scenarios into one runtime prompt.
4. Expose only the functions required in the active conversation phase.
5. Keep voice responses short and safe.
6. Require explicit confirmation before reservation creation or cancellation.
7. Transfer to a human when the request is unsupported or reliability is low.

## RAG

1. Every RAG chunk must belong to one immutable document version.
2. Use only approved sources from the source registry.
3. Return traceable sources and versions with RAG answers.
4. Do not implement RAG before its roadmap phase.

## Quality and reporting

1. Use TypeScript strict mode.
2. Follow the coding standards.
3. Run all relevant checks before declaring success.
4. Do not declare success when tests fail.
5. Produce an implementation report after every phase.

Every implementation report must include:

- files changed;
- functionality added;
- checks and tests run;
- results;
- assumptions;
- limitations;
- unresolved questions;
- documentation changes;
- recommendation for the next phase.

## Cost control

1. Respect prompt, token, latency, and cost budgets.
2. Prefer narrow context and phase-specific tools.
3. Do not add model calls or retrieval without a documented reason.
