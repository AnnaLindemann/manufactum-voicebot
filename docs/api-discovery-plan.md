# External API Discovery Plan

## Objective

Understand the real API before designing the integration.

## Known example shape

```text
GET /search?q=senf&warehouse=493024033844&limit=2
GET /search?q=209567&warehouse=493024033844
```

The exact API-key header must be confirmed.

## Local test script

Create:

```text
scripts/test-search-api.ts
```

The script must:

1. read base URL and API key from environment variables;
2. send a request;
3. print status;
4. print formatted JSON;
5. save a redacted sample;
6. catch timeout and JSON errors.

## Environment variables

```env
MANUFACTUM_API_BASE_URL=
MANUFACTUM_API_KEY=
MANUFACTUM_API_KEY_HEADER=
```

## Test matrix

### Query

- common keyword;
- exact product name;
- article number;
- partial word;
- typo;
- umlaut;
- empty;
- long text;
- special characters.

### Warehouse

- valid;
- invalid;
- omitted;
- phone format with `+`;
- digits-only format.

### Limit

- omitted;
- 1;
- 2;
- 10;
- 0;
- negative;
- non-numeric.

### Authentication

- valid key;
- missing key;
- invalid key;
- wrong header.

### Questions to answer

- stable product ID?
- article number?
- price and currency?
- stock boolean, status, or quantity?
- one warehouse or several?
- online availability?
- alternatives?
- URL and image fields?
- categories and variants?
- pagination?
- rate limits?
- reservation endpoints?
- required customer fields?
- cancellation behavior?
