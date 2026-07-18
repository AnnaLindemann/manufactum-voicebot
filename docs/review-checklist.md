# Phase Review Checklist

## Scope

- Was only the accepted roadmap phase implemented?
- Was future functionality excluded?
- Were assumptions documented?

## Documentation

- Are relevant documents present and consistent?
- Were documentation updates based on evidence?
- Are API contracts still marked provisional until discovery is complete?

## Security

- Are secrets absent from source code, logs, fixtures, documentation, and Git?
- Is `.env` ignored and `.env.example` present?
- Is personal data minimized and redacted where required?

## Code quality

- Does TypeScript type checking pass?
- Does linting pass?
- Does formatting verification pass?
- Do relevant automated tests pass?
- Are route handlers thin and inputs validated?
- Are raw upstream types separated from internal domain models where applicable?

## Runtime behavior

- Does the application start locally?
- Does `GET /health` return `200`?
- Are errors handled safely?
- Is no external API behavior invented?

## Acceptance

- Is an implementation report available?
- Are review findings resolved or explicitly accepted?
- Is the phase explicitly accepted before the next phase starts?
