FROM node:20-bookworm-slim
WORKDIR /app

# Install Chromium and dependencies for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libxkbcommon0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage"

COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY .env.example ./.env.example
# Prompt files are mounted via docker-compose volumes
VOLUME /app/data
EXPOSE 3000
CMD ["node", "src/index.js"]
