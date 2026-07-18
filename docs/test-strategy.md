# Test Strategy

## API discovery

Verify raw external behavior.

## Unit tests

- phone normalization;
- postal-code validation;
- product normalization;
- availability mapping;
- price parsing;
- error mapping;
- document hashing;
- chunk-key generation.

## Integration tests

Mock the external API and test internal endpoints.

## Contract tests

Store representative redacted responses and verify parsers still accept them.

## RAG tests

- exact question;
- paraphrased question;
- irrelevant question;
- inactive version excluded;
- source returned;
- low-confidence fallback;
- changed page creates new version;
- unchanged page creates no version.

## Voice tests

- German product names;
- numbers;
- article numbers;
- postal codes;
- interruptions;
- silence;
- noise;
- long names;
- corrections.

## Reservation safety

- double submit;
- duplicate confirmation;
- invalid reference;
- already cancelled;
- timeout after submit;
- unknown final state.

## Acceptance criteria

- no hallucinated price or stock;
- no reservation without confirmation;
- no inactive RAG chunk used;
- safe fallback on upstream failure;
- traceable answer source.
