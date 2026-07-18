# RAG Design

## Purpose

Provide grounded answers for service and policy information.

## Candidate content

- delivery;
- Click & Collect;
- returns;
- complaints;
- payment;
- vouchers;
- customer card;
- store services;
- contact information;
- FAQ;
- ordering rules.

## Exclusions

RAG is not the source of truth for:

- current price;
- current stock;
- reservation status;
- order status;
- rapidly changing availability.

## Source collection

### Stage 1

Manual approved URL registry.

### Stage 2

Sitemap-assisted discovery.

### Stage 3

CMS API or webhook, if available.

## Pipeline

```text
Approved URL
→ Fetch HTML
→ Extract main content
→ Normalize
→ Calculate document hash
→ Compare with active version
→ Create new version only when changed
→ Chunk
→ Calculate chunk hashes
→ Create embeddings
→ Store in pgvector
→ Activate new version
→ Preserve old versions
```

## Version rule

Every chunk belongs to exactly one immutable document version.

Recommended key:

```text
{document_key}:v{document_version}:chunk-{chunk_index}
```

Example:

```text
returns-policy:v4:chunk-003
```

## Required metadata

- document key;
- document version;
- chunk index;
- chunk hash;
- source URL;
- title;
- document type;
- language;
- created time;
- active flag;
- crawler version;
- extractor version.

## Change detection

```text
same normalized-content hash → no new version
different hash → create new document version
```

## Retrieval rules

- active chunks only;
- metadata filters where useful;
- source URL returned;
- document version returned;
- minimum relevance threshold;
- no-answer fallback;
- retrieved chunk IDs logged.
