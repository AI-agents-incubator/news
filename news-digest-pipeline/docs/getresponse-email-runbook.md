# GetResponse email draft — contract and runbook

## Boundary

The pipeline accepts the same durable Facebook source post used by the other
channels and creates one GetResponse newsletter **draft**. It never sends,
schedules, or selects recipients. Review and publication happen manually in
GetResponse.

Runtime settings:

- `GETRESPONSE_API_KEY`
- `GETRESPONSE_CAMPAIGN_ID`
- optional `GETRESPONSE_FROM_FIELD_ID`; otherwise the account default is used
- `BASE_URL` when the source post has an image, so the email client receives an
  absolute `/post-images/<file>` URL

## Rendered artifact

- Template: `src/pro/email/newsletter-template.v1.html`
- Instructions: `src/pro/email/newsletter-instructions.v1.md`
- Renderer: `src/pro/services/email-newsletter.js`
- Template and instruction contract: `getresponse-source-post.v1`

The first non-empty source line becomes the subject (maximum 100 characters).
The complete source post becomes both plain text and escaped HTML. Blank lines
become paragraphs, single newlines become `<br>`, and absolute http(s) URLs
become links. Untrusted GetResponse dynamic-tag delimiters are neutralized.
When a durable source image exists, the first image is inserted above the text.
The provider-managed legal footer is not copied into the custom HTML.

## Create and verification sequence

1. Read the configured campaign and require its provider postal footer.
2. Read account from-fields and resolve the configured or default sender.
3. Persist `create_pending`, attempt id, artifact SHA-256 and template metadata.
4. `POST /newsletters` exactly once with `type=draft`, no `sendOn`, and
   `sendSettings={}`.
5. Persist the returned newsletter id immediately as `created_unverified`.
6. Read that exact newsletter and require:
   - matching id and `type=draft`; when provider status is present, it is
     `enabled`;
   - exact subject and plain content;
   - HTML equal after ignoring only provider-owned `<meta>`, Outlook
     `<noscript>` and final-newline normalization;
   - matching campaign, sender and reply-to;
   - `sendOn` absent/null or exactly equal to provider `createdOn` (GetResponse
     currently fills both with the draft creation time);
   - the stable selected campaigns, contacts and segments arrays are present
     and empty; every other current or future array-valued audience field is
     also empty.
7. Persist `ready_for_review` and show `Draft` in the operator UI.

## Status and recovery

| Status | Meaning | Automatic retry |
|---|---|---|
| `failed` | Failure was confirmed before a provider draft could exist | Allowed |
| `create_pending` | Process stopped around the non-idempotent create boundary | Blocked |
| `created_unverified` | Provider id is durable; read-back not yet accepted | Blocked |
| `creation_uncertain` | POST outcome or strict verification requires inspection | Blocked |
| `ready_for_review` | Exact draft accepted; not sent | Not needed |

For any blocked state, inspect GetResponse before changing local state. Do not
press the Email button repeatedly: GetResponse newsletter creation is
non-idempotent and can create duplicates.

## Owner review

In GetResponse, open **Email Marketing → Drafts**, find the recorded newsletter
id/subject, and review desktop/mobile appearance, links, sender, campaign,
postal/unsubscribe footer and final recipients. Only the owner selects the
audience and publishes.
