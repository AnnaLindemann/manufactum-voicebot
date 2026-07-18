# Conversation Scenarios

## General rules

- Keep voice responses short.
- Ask one clarification question at a time.
- Never invent price, stock, reservation state, or policy.
- Confirm before creating or cancelling a reservation.
- Transfer quickly when the caller is angry or explicitly requests a person.
- Do not read long URLs aloud.
- Offer link delivery only when the channel integration exists.

## 1 — Exact product known

1. Identify store if missing.
2. Search exact phrase.
3. If one match: say product name, price, store availability, and online availability when available.
4. Offer another store, alternative, reservation, or link.

## 2 — Article number known

1. Search article number.
2. Confirm product name.
3. Ask for store.
4. Return price and availability.
5. Continue to reservation or alternatives.

## 3 — Product partially known

1. Search keyword.
2. Present at most two results.
3. Distinguish them briefly.
4. Ask which one is meant.

## 4 — Product described by use

Example: “I need a bread knife.”

1. Ask one useful criterion.
2. Search normalized keywords.
3. Present at most two matches.
4. State that they are search matches, not expert recommendations.
5. Offer a human adviser when confidence is low.

## 5 — No result

1. Repeat interpreted term.
2. Ask for article number, spelling, category, or description.
3. Retry once.
4. Offer online shop, another category, or human transfer.

## 6 — Store known

1. Resolve city or store.
2. If several stores match, ask for district or address.
3. Search using the mapped warehouse ID.

## 7 — Store by postal code

1. Ask for postal code.
2. Search store registry.
3. Rank by distance only when coordinates or geocoding are available.
4. Offer one or two stores.

A voice call does not automatically reveal postal code or location.

## 8 — Store by city

1. Resolve city.
2. Rank stores by distance from the city center or known coordinates.
3. Explain that this is based on the supplied city, not live device location.

## 9 — Product available

1. State current price.
2. State availability cautiously.
3. Offer reservation.

## 10 — Product unavailable

Offer:

1. another store;
2. online shop;
3. alternative;
4. human transfer.

## 11 — Alternative product

1. Explain why it is shown.
2. State price and availability.
3. Avoid unsupported quality claims.
4. Offer expert advice when needed.

## 12 — Reservation creation

1. Identify product and store.
2. Check availability.
3. Collect required contact data.
4. Summarize product, store, quantity, and price.
5. Ask for explicit confirmation.
6. Create reservation.
7. Return reference and expiry.

## 13 — Reservation cancellation

1. Ask for reservation reference.
2. Retrieve reservation when possible.
3. Repeat product and store.
4. Ask for explicit cancellation confirmation.
5. Cancel and confirm status.

## 14 — Reservation API unavailable

1. Say reservation cannot currently be completed.
2. Do not pretend it was saved.
3. Offer store contact, human transfer, link delivery, or retry later.

## 15 — Customer wants to order online

Initial version:

- confirm online availability;
- provide short product information;
- offer link delivery when implemented;
- transfer to customer service.

No payment or full order placement in MVP.

## 16 — Send a link

1. Ask for channel.
2. Collect destination.
3. Repeat destination.
4. Obtain consent.
5. Send and confirm status.

Until implemented, state the limitation directly.

## 17 — FAQ question

1. Query RAG.
2. Answer in one or two sentences.
3. Do not mix policy information with current stock.
4. Later offer source-link delivery.

## 18 — Angry customer

1. Acknowledge briefly.
2. Do not argue.
3. Transfer promptly.
4. Avoid unnecessary questions.

## 19 — Silence

1. Ask once whether the caller is still there.
2. Repeat the last simple question.
3. End politely after continued silence.

## 20 — API timeout

1. Do not guess.
2. Say availability cannot be checked reliably.
3. Offer retry or human transfer.

## 21 — Unsupported request

Examples:

- change an existing online order;
- payment dispute;
- complaint requiring customer-account access;
- expert suitability advice.

Transfer to a human.

## State model

```text
GREETING
→ IDENTIFY_INTENT
→ IDENTIFY_PRODUCT
→ IDENTIFY_STORE
→ SEARCH
→ PRESENT_RESULT
→ NEXT_ACTION
   ├─ OTHER_STORE
   ├─ ONLINE_SHOP
   ├─ ALTERNATIVE
   ├─ CREATE_RESERVATION
   ├─ CANCEL_RESERVATION
   ├─ SEND_LINK
   ├─ RAG_ANSWER
   ├─ TRANSFER
   └─ END
```
