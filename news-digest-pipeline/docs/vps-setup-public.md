# VPS Setup — News Digest Pipeline

This public runbook covers a fresh self-hosted installation. It intentionally
contains no QuestTales production hosts, credentials, rollback artifacts, or
private deployment topology.

## Requirements

- Ubuntu server with Docker Engine and Docker Compose v2
- a DNS name pointing to the server
- an HTTPS reverse proxy such as Traefik, Caddy, or nginx
- Node.js 20 only for local development and tests; production runs in Docker

## Configure

```bash
git clone https://github.com/AI-agents-incubator/news.git
cd news/news-digest-pipeline
cp .env.example .env
```

Fill the required values in `.env`. Keep that file outside Git and restrict its
permissions:

```bash
chmod 600 .env
```

Set the public host rule in `docker-compose.yml` for your own domain. Do not
reuse example domains or copy credentials from another installation.

## Start

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

Confirm the application health endpoint through both the container network and
your public HTTPS domain. A production deployment is complete only when the
container is healthy and the public health endpoint returns HTTP 200.

## Updating safely

Before updating, create a consistent SQLite backup and record the currently
running image. Build from a committed Git revision, recreate only the service
being updated, and verify health before removing rollback artifacts. Never copy
or restore a live SQLite WAL database as ordinary files; use SQLite's backup
API or a database-aware backup command.

The Telegram AI bots (Moderator, Assistant, and Gatekeeper) are a separate
product and are not part of this News deployment.
