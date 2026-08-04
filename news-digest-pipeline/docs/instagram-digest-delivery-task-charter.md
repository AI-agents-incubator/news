# Task Charter: linkless Instagram digest carousel

## Status

**Green — local implementation may proceed.** The required reader promise,
asset count, delivery boundaries, and authority are explicit. No production
publication, deployment, or external communication is authorized.

## Product outcome

For a review-ready 30-item digest, create exactly one Instagram carousel with
ten immutable 1080x1350 white assets: the approved digest cover and nine
model-selected, source-bound news cards. The reader can consume all 30 items
inside Instagram: a single canonical display text is made linkless *before*
splitting; its first 2,200 code points are the caption and the remaining text
is delivered as ordered continuation comments.

The cover must say exactly: `Листай 9 главных новостей. Все 30 — в подписи и комментариях`.

## Scope and exclusions

Included:

- durable local receipts, checkpoints, immutable asset ledger, schema/API/UI,
  model-cost accounting, tests, runbook, release metadata, and local evidence;
- mocked Meta carousel/comment delivery and read-only reconciliation paths.

Excluded:

- deployment, real Instagram publication, external messages, or mutation of a
  source digest record;
- URLs, source links, or a "link in profile"/`ссылки в профиле` funnel in any
  reader-visible card, caption, or continuation comment.

## Shared contract owner and integration order

`/root` is the sole owner of schema, receipt states, API DTOs, and integration.
Other workstreams may research or verify those contracts but do not modify
them. Integration proceeds in this order:

1. contract/migration and canonical-text primitives;
2. source-bound card preparation and immutable asset ledger;
3. one-shot carousel delivery, checkpointed comments, reconciliation;
4. route/dashboard review controls, docs and release metadata;
5. unit, integration, synthetic-user/local evidence, then commit/push.

## Acceptance criteria

- A prepared review has exactly ten immutable assets, each 1080x1350, in the
  persisted display order: cover first, then nine distinct model-selected
  source items. It fails closed if the count, source binding, image file, or
  dimensions cannot be proved.
- The existing digest cover is used as the editorial source; the stored digest
  text and digest row are never changed. Each new card model request has an
  append-only receipt, and every known token/cost is included in digest totals.
- Link removal happens exactly once on the canonical display text before the
  caption/comment split. No rendered part contains a URL or link-in-profile
  phrase, and the ordered parts do not duplicate or omit prose.
- The carousel publish attempt is durably marked before its only Meta write.
  A lost/timeout response is reconciled with read-only Meta calls; a missing or
  ambiguous result remains `inconclusive` and cannot issue another publish.
  Confirmed comments persist their exact index and ID before the next comment.
- Operator API/dashboard show the exact review assets and one of
  `preparing`, `ready`, `publishing`, `partial`, `published`, `failed`, or
  `inconclusive`; none implies a publish that local evidence did not prove.

## Evidence plan

| Gate | Owner | Required evidence |
| --- | --- | --- |
| Contract | root | fresh and upgraded SQLite schema; receipt/state tests |
| Cards/accounting | implementation | mocked model outputs, rendered 1080x1350 assets, reuse and cost aggregation |
| Delivery | implementation | mocked single-write carousel, retry/timeout, comment checkpoint and reconciliation tests |
| UI/API | QA | route DTO and dashboard review/status scenarios |
| Local release | root | Node 20 test suite, syntax/diff checks, synthetic-user/local walkthrough |
| Production | release owner | **not_run**: separate approval, deployment, test publication and live Meta evidence |

## Stop rules

Stop only for a true contradiction in the Instagram API needed to preserve the
no-duplicate guarantee, an uncovered reader-visible product decision, or an
action outside local authority. A merely unproven Meta result is recorded as
`inconclusive`; it is never retried as a write.
