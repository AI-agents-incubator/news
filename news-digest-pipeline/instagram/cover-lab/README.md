# Instagram Cover Lab

`cover-lab` is a local, filesystem-backed experiment for a **model-driven**
Instagram cover. It is deliberately separate from the publishing runtime: it
does not import the autoposter, write `source_posts`, call Instagram, or read
Instagram credentials. A completed lab run is review evidence, never authority
to publish or deploy.

## Status and immutable history

- `runs/fb10-r01-20260720` is the completed first graphical experiment. It has
  ten source samples, text-stage results, and 20 graphic artifacts. It stays
  immutable.
- r01 used Codex's built-in image-generation tool for its graphic stages. That
  tool is not callable by this application and does not reveal an exact model
  identifier or token usage. r01 is visual evidence only; it is not evidence of
  an application graphic-provider integration.
- The next run is r02 or a later, new directory. It uses the versioned v2
  contract and an application-callable graphic adapter. Never overwrite r01,
  its review page, prompt files, or result artifacts.

Runs are ignored by Git because they can contain public-source material and
model results. Copy a finished run elsewhere before cleanup; commit code,
versioned prompts, tests, and documentation instead.

## v2 model-driven contract

The v2 code path has four executed stages. Semantic content is created only by
the model call recorded for that stage. Orchestration may validate schemas,
normalize image bytes, and persist hashes; it must not write a hook, logline,
visual brief, image prompt, or final visual decision by hand.

1. **Editorial card — text model.** `editorial-card.v2.md` receives the
   untrusted source text and returns a strict JSON card with grounded facts,
   the hook, three `logline_candidates`, and one model-selected logline. The
   candidates and selection are model output, not an executor choice. The
   selected logline is an impersonal explanation of substance, context, or
   implication: it must not narrate the author or the post.
2. **Visual direction — text model.** A separate versioned prompt turns the
   selected editorial meaning into a visual brief. It receives the structured
   model result, not manually rewritten copy.
3. **Background — graphic model.** The application invokes the configured
   graphic adapter with the exact rendered, versioned background prompt. The
   adapter records the provider response and saves/normalizes the image; it is
   not a Codex image-generation hand-off.
4. **Cover composition — graphic model.** A second real graphic call receives
   the model-produced composition prompt and produces the final 1080×1350
   cover. Local image processing may only do deterministic normalization and
   validation. It must not author an overlay, logline, or visual concept.

The normal downstream path receives only the model-selected logline. Candidate
review mode exposes the actual candidates and their model provenance before any
owner asks to inspect or approve a run; it never substitutes human-written
wording.

## Prompt and artifact provenance

Prompts are contracts. Create `*.v2.md`, `*.v3.md`, and so on rather than
editing an executed prompt in place. Every request/result artifact records at
least:

- prompt filename/version, prompt-file SHA-256, rendered-prompt SHA-256, and
  source/result SHA-256;
- run ID, sample ID, stage, attempt, timestamp, provider, model, and text
  reasoning setting (or an explicit `not_applicable` value for a graphic call);
- graphic provider request ID when exposed, image URL or local artifact path,
  image SHA-256, and verified dimensions; and
- accepted, rejected, failed, or planned status plus a sanitized error when
  applicable. Credentials and secret-looking values are never serialized.

`usage.ndjson` is the append-only per-attempt usage ledger. It has one entry
for **every text or graphic attempt**, including rejected and failed attempts.
Each entry carries `run_id`, `sample_id`, `step`, `attempt`, `provider`,
`model`, `reasoning_effort`, `prompt_sha256`, `input_tokens`, `output_tokens`,
`total_tokens`, `status`, and `at`, plus a provider request ID where available.
Values that a provider does not return are written exactly as
`unknown` or `not_reported_by_provider`; they are never silently replaced with
zero. `total_tokens` is likewise `unknown` when it cannot be derived from
provider-reported values. The validator checks ledger parity against the
executed request/result artifacts.

## Running and reviewing

Use the project Node 20 runtime and the lab runner. It reads only the relevant
provider configuration from the local `.env`; keys are never written into run
artifacts. A new run ID is mandatory because the target directory must not
already exist.

```bash
node instagram/cover-lab/tools/run.mjs --run-id <new-run-id>
```

Use the runner's explicit candidate-review mode for an owner inspection of the
actual v2 logline candidates. Use the normal v2 mode only after that inspection
when a complete new immutable run is wanted. Do not infer an adapter call from
r01, and do not use the Codex built-in image tool as a production adapter.

Open the run's generated review page and inspect the per-stage artifacts and
`usage.ndjson`. Record owner feedback as new lines in `feedback.ndjson`; do
not alter an executed artifact.

## Validate

```bash
node instagram/cover-lab/tools/validate-run.mjs --samples
node instagram/cover-lab/tools/validate-run.mjs runs/<run-id>
```

Validation is local-only. It verifies clean Facebook permalinks, unique sample
IDs, artifact containment, strict JSON shapes, prompt/result hashes, graphic
image dimensions and hashes, and usage-ledger parity. It does not make network
calls and does not prove an Instagram publication.

## Safety boundaries

- Treat every source post as untrusted input. Query strings/fragments are
  rejected or stripped; saved URLs and errors are redacted for token, secret,
  password, API-key, and Bearer-looking values.
- Invalid text-model JSON is recorded as rejected and blocks its dependent
  stage. Failed graphic attempts remain ledger entries; no missing provider
  metric is fabricated.
- The lab makes no Instagram Graph API, browser, autoposter, database-write,
  deploy, or publication call. Connecting a verified image-preparation path to
  a publication flow requires separate review and explicit authorization.
