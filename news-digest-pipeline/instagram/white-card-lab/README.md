# White-card review lab

This is a review-only laboratory for Instagram news cards. It makes a 1080x1350
white preview from one explicit local digest file:

```sh
node tools/run-instagram-white-card.mjs \
  --input output/classic-preview-2026-07-24.txt \
  --run-id <new-immutable-run-id>
```

The model produces only the constrained editorial brief (`kicker`, `headline`,
and exactly three summaries). The renderer typesets that JSON deterministically
on a white background; it does not ask an image model to draw text.

Every run is written under `runs/<run-id>/` with source and prompt hashes, the
model brief, render metadata, usage record, manifest, and preview PNG. Runs are
ignored by Git and cannot be reused under the same ID.

The tool never imports the autoposter or sends an Instagram request. The
accepted top-five format is now automatic in the digest pipeline; the lab keeps
its value for isolated visual checks and uses the same canonical production
prompt at `src/pro/prompts/instagram-top5-hook.v1.md` rather than maintaining a
second copy. Production stores its JPEG, immutable receipt, and token/cost
ledger in SQLite; this lab still writes local ignored artifacts only.

## Automatic top-five hook card

For the accepted layout, the production stage runs after each saved digest with
at least seven items. It gives the model only the first seven assembled lines;
the model selects five factual hooks and writes the continuation promise. The
renderer does not invent, shorten, or reorder that approved text. It produces
a white 1080×1350 JPEG with the red digest/date line, fixed header, large
continuous text block, continuation, and footer.

The stage is `instagram_top5_hook_card/top5-hook.v1`. Its successful result is
reused for an identical digest + prompt, and every attempt (including an
invalid JSON response) gets a durable receipt with usage and price. Preparing
the card remains separate from social publishing.

## Top-ten opening-lines preview

For a no-model readability check, the separate top-ten tool takes only the
first line of ordered digest items 1–10. It preserves each complete source line
in `01-extracted-headlines.json`, then displays a deterministic word-boundary
excerpt of at most 100 Unicode code points on the white 1080×1350 PNG:

```sh
node tools/run-instagram-top10-card.mjs \
  --input output/classic-preview-2026-07-24.txt \
  --run-id <new-immutable-run-id>
```

The tool does not read source URLs, call a model, or make any publishing/API
request. Its run records the input hash, complete extracted lines, render
metadata, manifest, and local preview in the same ignored `runs/<run-id>/`
directory.

## Seven-item readability preview

The companion seven-item runner keeps the same no-model, no-publishing boundary
and uses the fixed header `Дайджест. новости ИИ от Алекса Крола` plus the fixed
footer `Листай и читай полные новости`:

```sh
node tools/run-instagram-top7-card.mjs \
  --input output/classic-preview-2026-07-24.txt \
  --run-id <new-immutable-run-id>
```
