# Security Audit Report

Date: 2026-04-13
Scope: repository review for `/Users/alexeykrolmini/Code/News`, with primary focus on `news-digest-pipeline/` and the bundled browser extension.

## Method

- Manual review of application code, routes, config, deployment files, scripts, and extension code.
- Dependency check with `npm audit --omit=dev --json`.
- Configuration hygiene checks for tracked and local secret files.
- Targeted validation of runtime assumptions where possible from the local workspace.

This is a source-level audit. It does not include black-box testing of the live host, TLS configuration verification, or cloud/VPS control-plane review.

## Executive Summary

Overall posture: **high risk**.

The main problem is architectural, not dependency-driven:

1. The production service is exposed on a public hostname, but the dashboard and API have **no authentication or authorization**.
2. The article ingestion endpoint accepts an arbitrary URL and performs server-side fetching, which creates a **critical SSRF path**.
3. Sensitive operational data is logged too broadly, and the local `.env` file is readable by all local users (`0644`).

Dependency review was comparatively clean: `npm audit --omit=dev` reported **0 known production vulnerabilities** at the time of review.

## Findings

### F-01: Public admin API and dashboard without authentication

Severity: **Critical**

#### Evidence

- `news-digest-pipeline/src/index.js:31-38` serves the dashboard and mounts all API routes with no auth middleware.
- `news-digest-pipeline/src/routes/articles.js:13-218` exposes create/read/update/delete operations for articles.
- `news-digest-pipeline/src/routes/digests.js:16-205` exposes digest generation, listing, reading, publishing, status changes, and deletion.
- `news-digest-pipeline/docker-compose.yml:18-24` publishes the service behind Traefik on `YOUR_DOMAIN`.

#### Impact

Any internet user who can reach the host can:

- read all stored articles and digests;
- trigger Anthropic-backed digest generation;
- publish content to Telegram and Facebook using the server's configured tokens;
- modify digest status and delete digests;
- patch and delete articles.

This is full compromise of the application's control plane.

#### Recommendation

Add authentication before exposing the dashboard or API publicly. The minimum acceptable fix is:

- protect the dashboard and all `/api/*` routes with strong auth;
- separate machine-to-machine endpoints from operator UI;
- require explicit authorization for destructive or billable actions;
- place the service behind a reverse proxy auth layer only as a temporary mitigation, not the final control.

Recommended implementation order:

1. Add server-side auth middleware in Express.
2. Require auth on all article and digest routes.
3. Restrict publishing and generation endpoints to operator-only access.
4. Consider moving the dashboard off the public internet entirely.

### F-02: SSRF via arbitrary URL ingestion, with data exfiltration path

Severity: **Critical**

#### Evidence

- `news-digest-pipeline/src/routes/articles.js:15-35` accepts any syntactically valid URL and fetches it server-side.
- `news-digest-pipeline/src/services/article-fetcher.js:78-94` performs direct `fetch(url)`.
- `news-digest-pipeline/src/services/article-fetcher.js:143-204` falls back to Playwright and browses the attacker-supplied URL.
- `news-digest-pipeline/src/routes/articles.js:118-136` returns stored article content to any caller.

#### Impact

An attacker can submit internal or privileged URLs such as:

- `http://localhost:...`
- RFC1918/private network targets
- metadata endpoints such as `http://169.254.169.254/...`

The fetched content is stored in SQLite and can then be retrieved through the unauthenticated article listing endpoints. This is a direct SSRF-to-exfiltration chain.

Using Playwright as a fallback increases impact because the service is willing to render and execute attacker-chosen pages, not just fetch raw HTML.

#### Recommendation

- Reject non-public destinations.
- Enforce an allowlist of approved source domains if this system is only meant to ingest a known set of sites.
- Resolve DNS and block loopback, link-local, multicast, and private IP ranges before connecting.
- Disable the Playwright fallback for user-supplied arbitrary URLs unless there is a very strong isolation story.
- If arbitrary fetching must remain, isolate it into a sandboxed worker with outbound egress controls.

### F-03: Sensitive request bodies are logged in plaintext

Severity: **Medium**

#### Evidence

- `news-digest-pipeline/src/index.js:23-29` logs the body of every non-health request.

#### Impact

Logs may contain:

- article content submitted by users;
- Telegram webhook payloads and user messages;
- digest manipulation payloads;
- attacker-controlled content that pollutes logs.

If logs are aggregated, shared with hosting staff, shipped to a third party, or retained for long periods, this becomes a data exposure issue.

#### Recommendation

- Remove body logging entirely in production.
- If request logging is needed, log only route, method, status, latency, and a request ID.
- Never log full webhook or content payloads by default.

### F-04: Local `.env` file permissions are too broad

Severity: **Medium**

#### Evidence

- Local file mode for `news-digest-pipeline/.env` is `0644` during this audit.
- The file contains live secret-bearing variables for Anthropic, Facebook, Telegram, and YouTube in the current environment.

#### Impact

Any local user account on the same machine can read API keys and publishing tokens. On a single-user laptop this may be tolerable for short periods; on a shared workstation or server it is not.

#### Recommendation

- Change permissions to `0600` for `.env`.
- Ensure deployment secrets on VPS use the same or stricter permissions.
- Prefer a secret manager or host-level injected environment for production.

### F-05: No rate limiting or abuse controls on expensive and destructive endpoints

Severity: **Medium**

#### Evidence

- `news-digest-pipeline/src/index.js:19-38` sets JSON parsing and logging but no rate limiting, abuse throttling, or request quotas.
- `news-digest-pipeline/src/routes/digests.js:16-42` exposes digest generation.
- `news-digest-pipeline/src/routes/digests.js:114-132` exposes social publishing.
- `news-digest-pipeline/src/routes/articles.js:67-116` accepts bulk article insertion up to the JSON body limit.

#### Impact

An attacker can:

- trigger repeated LLM usage and create avoidable cost;
- spam Telegram/Facebook publishing attempts;
- flood the database with junk articles;
- create avoidable operational load on Playwright and outbound HTTP.

This is currently overshadowed by F-01, but it remains important even after auth is introduced.

#### Recommendation

- Add IP-based and identity-based rate limiting.
- Put stricter limits on generate/publish endpoints.
- Add request quotas and idempotency protection for publishing.
- Bound batch sizes and enforce per-request item count caps.

## Positive Observations

- `news-digest-pipeline/.env` is ignored by Git, and `git ls-files` showed only `.env.example` is tracked.
- `news-digest-pipeline/.fb-profile/` is excluded from Git and currently has restrictive `0700` permissions.
- The Telegram webhook secret is configured in the current local `.env` used during this audit.
- The browser extension has narrowly scoped host permissions to Perplexity domains and does not inject remote code.
- `npm audit --omit=dev --json` reported **0** known production dependency vulnerabilities.

## Dependency and Tooling Notes

- `npm outdated --json` showed several packages behind latest major versions, but no confirmed production CVEs were surfaced by `npm audit` during this review.
- `npm test` did not run successfully in the current shell because the local Node runtime is `v16.14.0`, while the project expects a newer runtime; the Docker image uses Node 20. This is a verification gap, not itself a vulnerability.

## Prioritized Remediation Plan

1. Add authentication and authorization for the dashboard and all `/api/*` routes.
2. Close the SSRF path by allowlisting domains or blocking non-public network destinations before any fetch.
3. Remove request body logging in production.
4. Add rate limits around generate, publish, batch insert, and arbitrary fetch operations.
5. Tighten secret file permissions to `0600` and review production secret storage.

## Suggested Retest Scope After Fixes

- Unauthenticated access to `/`, `/api/articles`, `/api/digests`, and `/api/telegram/webhook`
- SSRF attempts to `localhost`, RFC1918 addresses, and `169.254.169.254`
- Repeated publish/generate abuse attempts
- Log review to confirm content bodies are no longer emitted
- Secret file permission checks on local and production hosts
