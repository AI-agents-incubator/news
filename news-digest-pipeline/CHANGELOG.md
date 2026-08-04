# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses semantic versioning.

## Project split — 2026-08-04

### Changed

- Split Telegram AI into the standalone AIchatTG product. Moderator, Assistant
  and Gatekeeper now own their webhook routes, configuration, SQLite state,
  model/runtime code and operator interfaces outside News.
- News keeps Telegram editorial URL intake and channel publication, plus
  Facebook Page comment moderation in News Pro.
- Public release generation now uses an explicit exact private source ref and
  rejects migrated Telegram-AI paths before a public sync can be committed.

### Removed

- Removed the legacy Telegram moderation/assistant runtime, Gatekeeper capture
  service, assistant evaluation corpus and course-index tooling from News.

### Migration

- Existing Telegram-AI tables may remain in a News SQLite database as inert
  historical data. Do not mount or copy that database into AIchatTG; any state
  import is a separate one-way migration.

## Assistant [2.4.34] — 2026-08-01

### Changed

- Telegram assistant invocation is now one public protocol: a question must
  start with `/ask`, while `/help` returns the deterministic Product
  Owner-approved instructions. Telegram's optional `@thisbot` command suffix
  remains transport-compatible but is not advertised.
- `/ai`, plain bot mentions, replies without a leading `/ask`, and commands
  embedded after a preface no longer invoke the assistant. The Telegram command
  menu now contains exactly `/ask` and `/help`.
- A bare `/ask` asks the user to resend one complete `/ask ваш вопрос` message
  without opening a force-reply continuation.
- Public and student help, the answer footer, the channel publication footer,
  current setup documentation, and the immutable public assistant profile v2
  now describe the same protocol. The assistant component footer reports
  version 2.4.34 dated 01.08.2026.

### Verification

- Focused Node 20 contract suite: 8 files and 247 tests passed, covering
  classifier, webhook, roles, help, public profile, visible delivery and the
  Telegram publisher footer. No Telegram message or provider call was used.
- Full Node 20 suite: 83 files and 1,219 Vitest tests passed; the Substack
  publisher contract also passed 13 / 13.

## Assistant [2.4.33] — 2026-08-01

### Fixed

- Telegram questions now cross an atomic, durable at-most-once claim keyed by
  platform, chat and native message ID before any provider or delivery call.
  Webhook redelivery, concurrent handlers, the polling fallback and edits of an
  already handled message therefore cannot generate a second answer.
- Historical assistant events are backfilled into the claim ledger without a
  uniqueness migration failure even when the old ledger contains duplicates.
- Short `/ai` and `/ask` presence checks such as «ау», «але» and «ты тут?» now
  receive a small deterministic response instead of a role redirect or silent
  cooldown skip. Neutral named-model questions such as «Ты DeepSeek?» use the
  public assistant profile.
- A high-confidence personal attack or veiled threat receives no assistant
  response and never reaches role/course/answer routing. The independent guard
  bot evaluates the same native update under its live moderation policy, where
  a confident threat is deleted and its non-exempt author is banned.
- Telegram moderation policy `tg-v2` makes the neutral identity/threat boundary
  explicit. Existing `tg-v1` databases advance monotonically to `tg-v2`; a
  manually selected newer policy is never rolled back.
- Silent suppression is enabled only for a chat covered by a configured live
  guard. Missing coverage or shadow mode fails closed to a visible refusal, and
  startup logs the readiness deficit without stopping unrelated pipelines.

### Verification

- Focused assistant/moderation suite: 11 files and 334 tests passed on Node
  20.20.0, including sequential and concurrent duplicates, edited messages,
  polling fallback, presence pings, normal self-profile questions and the
  split-bot threat route.
- Full Vitest suite: 83 files and 1,220 tests passed. Substack publisher contract:
  13 / 13 passed. No provider call, Telegram message or production database write
  was used for verification.

## Assistant [2.4.32] — 2026-07-30

### Added

- The course assistant now uses a bounded semantic navigator between the
  role/action gate and primary-source loading. A code-side recall stage narrows
  the 199-node index to at most 40 candidates, the model selects only closed
  catalog IDs, and the answer model receives only the selected original course
  excerpts.
- Query-aware headings, verified body-term matches and closed answer-shape
  signals recover material discussed inside a lesson even when the title does
  not contain the student's wording. Exact slash-command questions cannot be
  turned into a terminal model `not_found` when code has proved a matching
  `/handoff` source.
- A 66-case Russian synthetic retrieval corpus and a cost-fused isolated runner
  cover Claude Code variants, project setup, handoff/subagents, VS Code/Git,
  RAG versus external memory, body-only matches, multi-source questions,
  false premises, honest not-found, profiles, role redirects and safety gates.

### Changed

- The runtime rebuilds the content lexicon from validated primary text instead
  of trusting the generated term-to-ID map.
- Semantic selection is normalized code-side: missing compound-concept evidence
  can be added from own node metadata, while a broad unlinked QA is removed
  when a canonical selected topic already provides sufficient evidence.
- Exact production-tuple navigation is now grounded for Luna/minimal without
  changing the configured model. Query-only aliases and code-proved answer
  shapes improve recall, but never expand source evidence or inject unchecked
  node IDs.
- Navigator input fell from roughly 37,000 to 8,975 tokens per evaluated
  question on average; measured routing cost fell from about $0.095 to about
  $0.024 per question with the same configured model.
- The Telegram assistant footer now has its own component release number. The
  shared package version and publishing/dashboard badges remain owned by the
  production integrator and are not changed by this assistant-only release.

### Verification

- Canonical course index: 199 nodes, internal SHA-256
  `b8b2131c0256635ca6c394a0e3aea39d089a48e2ee5b8e210bb9514b54969504`.
- Exact production tuple (`gpt-5.6-luna`, OpenAI, `minimal`) passed 54 / 54
  runnable retrieval cases; 12 role/safety cases were deliberately `not_run`
  by the direct navigator and remain covered by the production-path suite.
- The original five Luna failures and the later two-case regression both
  passed targeted provider rechecks (5 / 5 and 2 / 2). The immutable 49 / 5
  and 52 / 2 reports remain in release evidence.
- Three corpus expectations were corrected only where the canonical 199-node
  index directly supports additional valid sources; these changes are listed
  separately from the runtime fix in the release evidence.
- All retained Terra and Luna release reports cost $4.533437 across 362 model
  calls, including superseded and negative attempts. No Telegram send or
  production database write occurred.
- Full Node 20 suite: 81 files, 1,118 Vitest tests and 13 Node publisher tests
  passed.

## [2.4.31] — 2026-07-30

### Fixed

- The version at the bottom of every assistant reply is now derived from the
  release manifest, preventing a stale footer after a version bump.
- A question about a different automation bot no longer opens the assistant's
  own `/help` merely because it contains the word «молчит».
- An explicit question about a lesson, module or course material remains inside
  the current-course source package if the role gate produces a false redirect;
  the security preflight remains ahead of this recovery.
- Choosing a course for a named business task and estimating learning time now
  use semantic navigation rather than lexical retrieval from unrelated lesson
  text.

### Verification

- Targeted assistant regressions: 122 tests passed.
- Full Node 20 suite: 77 files, 1,074 Vitest tests and 13 Node tests passed.
- After the footer derivation fix: 77 files, 1,075 Vitest tests and 13 Node
  tests passed.

### Production receipt

- Deployed on 2026-07-30 at 14:15 PDT from the verified 2.4.31 runtime delta,
  then recreated `news-digest` at 14:18 PDT to include the manifest-derived
  footer fix from `3351151`.
- The initial pre-deployment rollback archive is
  `.rollbacks/20260730-2114-assistant-2.4.31.tar.gz` (SHA-256
  `fb55eef259251f60a9fca37857e37e736eaac3828621f6629ffaf02f825cad43`);
  the immediate pre-footer source is retained as
  `.rollbacks/20260730-2120-assistant-2.4.31-footer.js` (SHA-256
  `415d22e46cab8dfbae2d21c5fc349ed40d2feaade44e07fcd7b4f604ca32fe1a`).
- Only the assistant runtime, its topic registry, release labels and manifest
  version were delivered; the final correction replaced only
  `src/pro/moderation/assistant.js`. Production `.env`, data, prompts, output
  and Compose configuration were not changed.
- The container is healthy; its internal and public HTTPS `/health` endpoints
  return `200`, anonymous assistant configuration remains `401`, the canonical
  course index loads 199 nodes, and the active footer is `Версия 2.4.31 от
  30.07.2026`. No Telegram message or paid provider call was used as a smoke
  test.

## [2.4.30] — 2026-07-30

### Changed

- The public Telegram chat now receives the same detailed, source-grounded
  course answers and up to three code-selected lesson links as the student chat.
  The assistant no longer turns each public course answer into a purchase pitch.
- The base assistant prompt and course guards now explicitly preserve the role
  boundary: the bot navigates course material and does not replace a coding
  agent.
- Public `/help` documents the detailed, catalogue-backed navigation behavior.
- Visible assistant and dashboard release labels report `2.4.30` / `Версия
  2.4.30 от 30.07.2026`.

### Security

- Student-only entitlements, including the verified Telegram-channel folder,
  remain guarded by the trusted student `chat_id` profile. Public users cannot
  acquire them through a question or model output.

### Verification

- Focused profile, retrieval, router and isolated-evaluation tests: 140 / 140
  passed.
- Full Node 20 suite: 74 files, 993 tests passed. No Telegram message or paid
  provider call was made during verification.

### Production receipt

- Deployed on 2026-07-30 at 13:07 PDT from
  `96d4a649061c28ea689d0741c234d838f940c9c9`; the runtime archive SHA-256 was
  `ac78731ab7413eca0f6c90d7ae63d98c2a345644257333c2d6f3a764330d3495`.
- A rollback archive was created before replacement. Only `src/`,
  `package.json` and `package-lock.json` were delivered; `.env`, data, prompts,
  output and production Compose remained host-owned and unchanged.
- `news-digest` alone was rebuilt and recreated. Container health plus internal
  and public HTTPS `/health` returned `200`; unauthenticated assistant config
  remained `401`. The active course index has 199 nodes.
- The production resolver reports two authorized chats with one student profile;
  both profiles expose detailed/no-promotion/catalog course behavior. No
  synthetic Telegram message or paid provider call was used for the smoke test.

## [2.4.29] — 2026-07-30

### Added

- A generated, validated hierarchical index of canonical course topics and
  substantive lessons. It retrieves original source text only after the security
  and role/action gates; summaries are navigation metadata, not answer evidence.
- In the student profile, verified URLs are appended by code from the retrieval
  trace. The answer model sees titles but never URLs.
- The isolated evaluation runner can exercise both public and student profiles
  with synthetic, non-production chat IDs.

### Fixed

- A detailed comparison of RAG and external memory now preserves one
  title-authenticated source for each named concept instead of letting a broad
  course overview displace the external-memory lesson.

### Verification

- Index parser accepted course `143216` / `ai_full`: 199 nodes (119 topics and
  80 lessons), no validation issues, file SHA-256
  `64544085b9066d81050fb077e6c0c8f3229b53e9aced828c64acb8765d05b3b6` and
  index SHA-256 `b8b2131c0256635ca6c394a0e3aea39d089a48e2ee5b8e210bb9514b54969504`.
- Isolated real-provider checks in the synthetic student profile retrieved:
  RAG → lesson 5.1 (`/lessons/123/`); external memory → the canonical topic
  URL; the comparison → both sources and both code-owned URLs. No Telegram send
  or production database write occurred.
- Full Node 20 suite: 80 files, 1,094 Vitest tests and 13 Node tests passed.

### Production receipt

- Deployed at 12:16 PDT from
  `f390cceab1c56d138b76fe653a815ffc93696a86`. A rollback archive of the
  previous runtime was created first; delivery used a content-addressed Git
  archive (`ceda9393d88622c37926ce22e83baa30183c26ee1c189c9fff20b9785ec8a694`)
  containing only `src/`, `package.json` and `package-lock.json`.
- The index artifact was separately checksum-verified and atomically installed.
  Host `.env`, Compose, prompts, output and the main SQLite schema were not
  changed. Only `news-digest` was rebuilt/recreated.
- Container and public HTTPS health returned `200`; unauthenticated assistant
  config returned `401`. The running container reports version `2.4.29`, role
  gate/router bank/course index all enabled, a valid 199-node index, zero pending
  moderation rows and zero assistant delivery errors during the ten-minute
  post-deploy window.

## [2.4.28] — 2026-07-30

### Fixed

- A direct `/ai` command or `@alexkrol_moderation_bot` mention may now follow a
  short, completed natural-language lead-in in the same group message. Quoted,
  code-formatted and forwarded examples remain inert.
- The closed student profile keeps its detailed, methodological no-sale policy
  even when a topic’s optional knowledge slice is temporarily unavailable.

### Added

- A direct closed-chat request for the recommended Telegram-channel folder gets
  a deterministic, code-owned answer with only the verified folder and the
  «Важные ссылки» lesson; the answer model is not invoked for that narrow case.

### Changed

- `/help` documents the accepted short preface before an invocation.
- Visible assistant and dashboard release labels report `2.4.28` / `Версия
  2.4.28 от 30.07.2026`.

### Verification

- Focused Telegram invocation, student-profile, navigation and assistant tests:
  176 / 176 passed.
- Full repository suite: 79 files, 1,080 Vitest tests and 13 Node tests passed.

### Production receipt

- Delivered on 2026-07-30 at 01:42 PDT from
  `dac3957d6a586092f3053f6ff3bbfde46a2d4b7d` through a Git archive containing
  only `src/`, `package.json` and `package-lock.json`. The pre-release runtime
  and protected `.env` were backed up; data, prompts and Compose were preserved.
- `news-digest` alone was rebuilt and recreated. Container health and public
  HTTPS `/health` returned `ok`; unauthenticated `/api/moderation/assistant/config`
  returned `401`.
- The effective release reports 2.4.28, safety/role gate/topic bank enabled,
  two authorized chats with one student and one public profile. The production
  parser accepted both approved lead-in invocation forms and preserved the RAG
  question text; the Telegram webhook was active with zero pending updates and
  no last error. No synthetic Telegram message or paid provider call was used.

## [2.4.27] — 2026-07-30

Production release for the paid Telegram student-chat profile. Deployed on
2026-07-30 at 00:39 PDT from `6f3dbd6a281f80132cfa827fd8e2bca038d8dc95`.

### Added

- `ASSISTANT_STUDENT_CHAT_IDS`: a fail-closed student-profile list which is
  intersected with the existing Q&A chat allowlist; the setting cannot grant a
  new chat access to the assistant.
- A compact, code-owned catalogue of canonical `ai_full` lesson URLs. The topic
  bank selects up to three relevant entries; code, not the answer model, renders
  those links at the end of a student reply.

### Changed

- In a configured student chat the assistant gives detailed, course-grounded
  navigation, without a purchase invitation or course promotion. `/help` is
  profile-aware and states that the bot does not replace a coding agent.
- The answer-model prompt receives only allowlisted lesson titles. Exact URLs
  stay outside the model prompt, which prevents invented or substituted deep
  links.
- Visible assistant and dashboard release labels now report `2.4.27` / `Версия
  2.4.27 от 30.07.2026`.

### Verification

- Targeted student-profile and routing tests: 105 / 105 passed.
- Full repository suite excluding an unrelated, untracked Substack test file
  with no test definitions: 76 files, 1042 tests passed.

### Production receipt

- A rollback archive of the previous runtime source and a protected `.env`
  backup were created on the VPS. The source delivery used a Git archive of
  `6f3dbd6`, not the dirty local working tree; host-owned data, prompts, output
  and production Compose were preserved.
- `news-digest` alone was rebuilt and recreated. Container health plus internal
  and public HTTPS `/health` returned `200`; the unauthenticated assistant
  configuration boundary returned `401`.
- The closed role gate and router bank are enabled. There are two authorized
  assistant chats, exactly one configured student profile, and one public
  profile. The student resolver returns `student`; the canonical catalogue
  returns three `agent-core` links.
- Telegram reports a configured webhook, zero pending updates and no last error.
  No synthetic Telegram message or paid provider call was used as a smoke test.

## [2.4.26] — 2026-07-29

Release documentation for the owner-authorized Telegram Q&A role/source
architecture. Deployed to production on 2026-07-29 at 23:17 PDT from
`00c37b180432991a7d503bb29b3ccb98a67fc786`; the receipt below is based on
post-deploy checks, not inferred from local or isolated evaluation.

### Added

- A single explicit `current-course` source package for the Telegram Q&A
  assistant, with source-local topic routing.
- A global closed role/action gate with `teach`, `navigate`, `support` and
  `redirect` outcomes before topic selection.
- `/ai` invocation alongside `/ask`, deterministic `/help`, and a compact usage
  hint plus the release line `Версия 2.4.26 от 29.07.2026` at the bottom of every
  visible assistant reply.
- Isolated 60-turn role/source routing evidence in
  `eval/role-source-synthetic-v1/`.

### Changed

- Routing order is now safety → role/action → source-local topics → answer.
- Safety-router failure stops the request before knowledge or an answer-model
  call; malformed or unavailable role-gate output redirects instead of allowing
  a default answer.
- Bot-operation questions are legitimate deterministic support. Short
  follow-ups carry only allowlisted topic IDs and labels for the same user, never
  raw earlier questions or answers.

### Fixed

- The assistant no longer treats a request to develop, deploy or analyse a
  user's project as a task for itself; it redirects to an appropriate code agent
  or specialist while remaining able to explain the course methodology.

### Verification

- Isolated pre-deploy run on 2026-07-29: safety 8/8, out-of-source redirects
  14/14, topic containment 29/38 before the final three targeted repairs;
  accounted provider cost $2.687934 under a $20 cap.
- Groundedness and answer-quality were not evaluated because the isolated run
  did not mount the course knowledge slices. The full post-repair routing score
  remains inconclusive until another explicitly approved isolated run.

### Production receipt

- `news-digest` was rebuilt and recreated as the only changed service; the
  resulting container became healthy at 23:18 PDT.
- Internal and public HTTPS `/health` both returned `status: ok`; the protected
  assistant configuration endpoint still returned `401` when unauthenticated.
- In the running container, the assistant, role gate and topic bank are enabled;
  the configured assistant-chat allowlist contains one chat. Runtime version and
  footer both report `2.4.26` / `Версия 2.4.26 от 29.07.2026`.
- SHA-256 values for all ten changed runtime source files and both package
  manifests match commit `00c37b1`. No Telegram message was sent as a production
  smoke test; live answer behaviour remains subject to normal case monitoring.
