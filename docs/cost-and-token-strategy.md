# Cost and Token Strategy

## Purpose

Control cost, latency, and context size throughout the voicebot lifecycle.

## Principles

- Use the smallest model and context that safely completes the active task.
- Load only the current conversation phase and its allowed functions into the Dialfire prompt.
- Do not load the complete scenario catalogue into every prompt.
- Keep voice responses concise.
- Retrieve only the minimum RAG context needed for an answer.
- Do not call an API, model, or retrieval service without a documented purpose.

## Cost categories

Track separately:

- Dialfire call duration;
- speech-to-text and text-to-speech usage, when applicable;
- conversation model usage;
- data-extraction model usage;
- backend API calls;
- RAG embedding creation;
- RAG retrieval;
- link-delivery provider usage;
- infrastructure and logging.

## Metrics per scenario

Record:

- scenario name;
- call duration;
- prompt and completion tokens, when available;
- number of model calls;
- number of backend calls;
- latency;
- direct cost;
- fallback or transfer rate;
- successful completion rate.

## Cost controls

- Use phase-specific prompts.
- Limit product result lists to the minimum useful number.
- Limit RAG chunks and apply a relevance threshold.
- Cache only data that is safe to cache and never treat cached price or stock as current truth.
- Set backend timeouts and avoid repeated retries without a limit.
- Review unusually expensive or slow scenarios before expanding them.

## Baseline and budgets

No production baseline exists yet.

Cost and latency budgets are defined after the first Dialfire and API-discovery measurements.
