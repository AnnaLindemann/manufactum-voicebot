# RAG Source Registry

## Status

- proposed;
- approved;
- rejected;
- paused.

## Source template

```yaml
document_key: returns-policy
url: https://www.manufactum.de/...
document_type: returns
language: de
status: proposed
owner: client
refresh_policy: daily
content_selector: unknown
exclude_selectors:
  - nav
  - footer
  - script
  - style
notes:
  - Confirm final URL.
  - Confirm whether CMS API is available.
```

## Initial categories

- ordering;
- payment;
- shipping;
- Click & Collect;
- returns;
- complaints;
- vouchers;
- customer card;
- store services;
- store contact pages;
- customer-service FAQ.

## Excluded by default

- product catalogue;
- search results;
- campaign pages;
- account pages;
- checkout;
- cookie pages;
- privacy and legal pages unless explicitly required.

## Approved sources

### `mein-konto` — account FAQ

The first approved source, verified by the extraction proof-of-concept on 2026-07-21. The page is
server-rendered; all 12 accordion answers are present in the raw HTML without JavaScript, so a plain
`fetch` plus a static parser (Cheerio) is sufficient. Selection uses only stable `data-test-*` hooks
and ARIA relationships — never the obfuscated `mf-*` CSS classes.

```yaml
document_key: mein-konto
url: https://www.manufactum.de/konto-c201130/
document_type: account-faq
language: de
status: approved
owner: client
refresh_policy: manual
page_title_selector: "h1[data-test-stelar-headline]"
content_selector: "[data-test-sell-element-accordion-element]"
question_selector: "[data-test-sell-accordion-item-heading]"
answer_selector: 'div[role="region"]'
exclude_selectors:
  - "[data-test-sell-header]"
  - "[data-test-sell-footer-sections]"
  - "[data-test-sell-local-navi]"
  - script
  - style
notes:
  - Server-rendered; collapsed accordion answers require no JavaScript (PoC-verified).
  - 12 FAQ items verified on 2026-07-21.
  - The answer panel `id` pairs with the item button `aria-controls`.
  - Never select on obfuscated `mf-*` CSS classes; they are build artefacts.
```

Extraction is implemented in `src/rag/extract-faq.ts` and covered by a network-free fixture test
(`tests/fixtures/rag/konto-c201130.html`). Automatic crawling of the left-navigation categories,
embeddings, storage, and the retrieval endpoint are explicitly out of scope for this phase.
