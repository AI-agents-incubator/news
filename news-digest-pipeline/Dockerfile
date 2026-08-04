FROM node:20-bookworm-slim
WORKDIR /app

# Server-side Chromium/Playwright was removed (2026-06): article content is
# fetched by the local Mac fetcher (real Chrome via AppleScript), never on the
# server, so the headless browser was ~400MB of dead weight. Keep only:
#   - wget: used by the docker-compose healthcheck
#   - ca-certificates: outbound HTTPS to model providers
#   - Noto Sans: reproducible Cyrillic typography for the rendered Instagram card
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    fontconfig \
    fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY scripts/repair-source-post-instagram-comment-thread.js ./scripts/repair-source-post-instagram-comment-thread.js
COPY .env.example ./.env.example
# Prompt files are mounted via docker-compose volumes
VOLUME /app/data
EXPOSE 3000
CMD ["node", "src/index.js"]
