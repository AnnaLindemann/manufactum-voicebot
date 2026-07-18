# Project Decisions

## D-001 — Custom backend

Accepted.

It protects credentials, normalizes external APIs, supports RAG, logging, tests, and stable Dialfire integration.

## D-002 — Start with API discovery

Accepted.

Observed responses are more reliable than assumptions.

## D-003 — No database during first API tests

Accepted.

A database is unnecessary until the API format is understood.

## D-004 — PostgreSQL and pgvector for RAG

Planned.

## D-005 — Version every document and chunk

Accepted.

Every chunk belongs to one immutable document version.

## D-006 — Price, stock, and reservation state never come from RAG

Accepted.

## D-007 — Begin RAG with an approved URL list

Accepted.

## D-008 — Deploy only after one local endpoint works

Accepted.

## D-009 — Link delivery is not part of the first milestone

Accepted.

The architecture must still leave room for it.

## D-010 — Voice calls do not reveal precise location

Accepted.

The bot must ask for city or postal code unless an external channel supplies coordinates.
