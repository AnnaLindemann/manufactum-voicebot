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
