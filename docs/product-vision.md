# Product Vision

## Product name

Manufactum Voice Assistant Backend

## Problem

Customers ask product and store questions that require several manual steps or several systems.

Typical examples:

- “Do you have this product?”
- “What does it cost?”
- “Is it available in Berlin?”
- “Which other store has it?”
- “I do not know the exact product name.”
- “Can you reserve it?”
- “Can you cancel my reservation?”
- “Where is the nearest store?”
- “Can you send me the link?”
- “I want to speak with a person.”

The assistant must answer quickly without inventing price, stock, reservation status, or policy information.

## Vision

Build a reliable AI voice assistant that combines:

- real-time transactional APIs;
- a custom orchestration backend;
- a versioned RAG knowledge base;
- Dialfire conversation control;
- safe human escalation.

## MVP capabilities

1. Identify customer intent.
2. Identify or clarify a product.
3. Identify or resolve a store.
4. Search products.
5. Return price and availability.
6. Search other stores.
7. Return online availability when supported.
8. Provide alternatives.
9. Create a reservation when supported.
10. Cancel a reservation when supported.
11. Transfer to a human.
12. Answer selected FAQ questions through RAG.
13. Avoid unsupported claims.

## Non-goals for the first version

- full order placement;
- payment processing;
- authenticated customer-account access;
- access to order history;
- autonomous changes without confirmation;
- outbound marketing;
- complex recommendation logic.

## Success criteria

- no hallucinated price or stock;
- safe fallback on API failure;
- product ambiguity is resolved conversationally;
- store ambiguity is resolved conversationally;
- reservation changes require confirmation;
- every RAG answer is traceable to source and version;
- Dialfire can reach the deployed backend over HTTPS.
