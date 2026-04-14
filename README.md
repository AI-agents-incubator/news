# News Digest Pipeline v1.0.0

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](#changelog)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude API](https://img.shields.io/badge/Claude_API-Opus_4-d97706?logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![SQLite](https://img.shields.io/badge/SQLite-Database-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-0088cc?logo=telegram&logoColor=white)](#)
[![Facebook](https://img.shields.io/badge/Facebook-Graph_API-1877f2?logo=facebook&logoColor=white)](#)

> Автоматизированный пайплайн: собирает новости → генерирует авторские комментарии через Claude API → публикует в Telegram, Facebook, Instagram.
>
> Проект реализован в рамках учебного курса: **Создание ИИ Агентов и приложений для бизнеса, роста, дохода и кайфа. 2.1/10-02-26**
>
> Хотите научиться делать такое же, а не смотреть как баран на новые ворота? Попробуйте этот курс. 14 дней пробный период: **https://alexeykrol.com/ai_full/**

**Примеры готовых дайджестов:**
[Facebook](https://www.facebook.com/alex.v.krol/posts/pfbid02oj14ZFeSvyrrpcNN8dBJoJ6YsegA4gSeqtsSdhVMjkAYZU15aFuRH7msPN3EuE8al) ・ [Telegram](https://t.me/alexkrol/8510) ・ [YouTube](http://youtube.com/post/UgkxFs7bfPTzCMBtYq_UT2ttLd6TVNRenVRL?si=olNJLuQs_ZVqlarq)

---

## Что это делает

1. Вы скидываете ссылки на новости в **Telegram-бота** (или через iOS Shortcut)
2. Когда накопилось **13+ статей** — Claude API автоматически генерирует дайджест
3. На **дашборде** появляется готовый дайджест с кнопками публикации
4. Одним кликом публикуется в **Telegram** и **Facebook**

Без ручного копирования, без вёрстки, без рутины.

---

## Архитектура

```mermaid
graph TB
    subgraph "📱 Вход"
        A[iPhone / Telegram] -->|URL ссылки| B[Telegram Bot]
        A2[Chrome Extension] -->|JSON batch| C[API]
    end

    subgraph "☁️ VPS"
        B --> D[(SQLite)]
        C --> D
        E[Queue Manager<br/>каждые 60 сек] -->|13+ статей?| F[Claude API]
        D --> E

        F -->|Phase A: комментарий| G[Opus 4]
        G -->|Phase B: сборка| H[Готовый дайджест]
        H --> I[(SQLite)]
        I --> J[Dashboard]
    end

    subgraph "📤 Публикация"
        J -->|📨 TG| O[Telegram канал]
        J -->|📘 FB| P[Facebook Page]
        J -->|📋 Copy| Q[Буфер обмена]
    end

    subgraph "🖥️ Mac"
        L[local-fetcher.js] -->|Chrome| D
        M[fb-publish.js] -->|Patchright| N[Facebook Profile]
    end

    style A fill:#0088cc,color:#fff
    style F fill:#d97706,color:#fff
    style J fill:#059669,color:#fff
    style O fill:#0088cc,color:#fff
    style P fill:#1877f2,color:#fff
```

---

## Быстрый старт

### 1. Форк и клонирование

```bash
git clone https://github.com/YOUR_USERNAME/news.git
cd news/news-digest-pipeline
```

### 2. Настройка

```bash
cp .env.example .env
```

Заполните `.env`:

```env
# Обязательные
ANTHROPIC_API_KEY=sk-ant-...        # Claude API ключ
TELEGRAM_BOT_TOKEN=123456:ABC...    # Токен от @BotFather
TELEGRAM_CHAT_ID=123456789         # Ваш Telegram user ID

# Опционально (для публикации)
TELEGRAM_PUBLISH_CHAT_ID=-100...   # ID канала для публикации
FACEBOOK_PAGE_ID=...               # ID Facebook Page
FACEBOOK_PAGE_ACCESS_TOKEN=...     # Page Access Token

# Безопасность
API_SECRET_KEY=...                 # Сгенерируйте: openssl rand -base64 32
DASHBOARD_PASSWORD=...             # Отдельный пароль для дашборда
```

### 3. Запуск

```bash
npm install
npm start
```

Дашборд: `http://localhost:3000` (логин: `admin` / ваш `DASHBOARD_PASSWORD`)

### 4. Production (Docker)

```bash
docker compose up -d --build
```

---

## Как работает генерация

```mermaid
flowchart LR
    subgraph "Phase A — Комментарии"
        A1[Статья 1] -->|prompt.md| C1[Claude Opus]
        A2[Статья 2] -->|prompt.md| C2[Claude Opus]
        A3[Статья N] -->|prompt.md| C3[Claude Opus]
        C1 --> R1[80-150 слов]
        C2 --> R2[ироничный тон]
        C3 --> R3[скептика]
    end

    subgraph "Phase B — Сборка"
        R1 --> ASM[Claude Opus]
        R2 --> ASM
        R3 --> ASM
        CFG[config.md] --> ASM
        ASM --> DIGEST["#новости  1. ...<br/>2. ...<br/>Курс<br/>Граница<br/>Хэштеги"]
    end

    style C1 fill:#d97706,color:#fff
    style C2 fill:#d97706,color:#fff
    style C3 fill:#d97706,color:#fff
    style ASM fill:#d97706,color:#fff
    style DIGEST fill:#059669,color:#fff
```

Два промпта управляют стилем:
- **[prompt.md](prompt.md)** — как писать комментарий (тон, длина, формат)
- **[assembly_prompt.md](assembly_prompt.md)** — как собирать дайджест (порядок, курс, подвал)
- **[config.md](config.md)** — хэштеги, упоминание курса, граница

---

## Dashboard

| Функция | Описание |
|---------|----------|
| 👁 **Смотреть** | Превью первых 3 новостей |
| 📨 **TG** | Публикация в Telegram канал |
| 📘 **FB** | Публикация на Facebook Page |
| 📋 **Копировать** | Текст в буфер обмена |
| ✕ **Удалить** | Удалить дайджест |
| **Статус** | Черновик / Опубликован (с датой) |

Защищён HTTP Basic Auth + rate limiting.

---

## Facebook Profile (Browser Automation)

Публикация в личный профиль через **Patchright** (stealth Playwright fork):

```bash
# Первый раз — залогиниться
node scripts/fb-publish.js --login

# Публикация
node scripts/fb-publish.js latest
```

Подробнее: [docs/facebook-setup.md](news-digest-pipeline/docs/facebook-setup.md) — детальное описание борьбы с Facebook bot detection.

---

## Медиа-пайплайны (в разработке)

### Instagram (изображения)

```mermaid
flowchart LR
    D[Дайджест] --> H[Claude Opus<br/>5-step headlines]
    H --> T[Заголовок + буллеты]
    TPL[Шаблон-референс] --> IMG[fal.ai / Recraft V3]
    T --> OVR[Sharp: текст на плашке]
    IMG --> OVR
    OVR --> FINAL[1080×1350 PNG]
    FINAL --> IG[Instagram API]

    style H fill:#d97706,color:#fff
    style IMG fill:#7c3aed,color:#fff
    style FINAL fill:#059669,color:#fff
```

### Video (Reels / Shorts)

```mermaid
flowchart LR
    D[Дайджест] --> S[Claude: Storyboard<br/>6 shots × 5-15 сек]
    S --> V[Kling 3.0 / Veo 3.1]
    V --> C1[shot_01.mp4]
    V --> C2[shot_02.mp4]
    V --> C3[shot_N.mp4]
    C1 --> FF[FFmpeg concat]
    C2 --> FF
    C3 --> FF
    FF --> R[reel_final.mp4<br/>1080×1920]

    style S fill:#d97706,color:#fff
    style V fill:#7c3aed,color:#fff
    style R fill:#059669,color:#fff
```

---

## API

Все endpoints (кроме `/health`) требуют аутентификации: `Authorization: Bearer <API_SECRET_KEY>`

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/health` | Статус сервера (публичный) |
| `GET` | `/` | Dashboard (Basic Auth) |
| `POST` | `/api/articles` | Добавить статью по URL |
| `POST` | `/api/articles/batch` | Пакетная загрузка |
| `GET` | `/api/articles/stats` | Статистика |
| `POST` | `/api/digests/generate` | Ручная генерация |
| `GET` | `/api/digests` | Список дайджестов |
| `GET` | `/api/digests/:id/text` | Чистый текст |
| `POST` | `/api/digests/:id/publish` | Публикация `{platforms: ["telegram","facebook"]}` |
| `DELETE` | `/api/digests/:id` | Удалить дайджест |

---

## Безопасность

- API и Dashboard защищены аутентификацией (Bearer / Basic Auth)
- Раздельные ключи для API и Dashboard
- Rate limiting: 30 req/min (API), 10 attempts/15min (Dashboard)
- SSRF-защита: whitelist только `perplexity.ai`
- Timing-safe сравнение ключей
- `.env` не в git, права `0600`

Полный аудит: [SECURITY_AUDIT_2026-04-13.md](SECURITY_AUDIT_2026-04-13.md)

---

## Структура

```
├── prompt.md                     # Промпт: комментарий к статье
├── assembly_prompt.md            # Промпт: сборка дайджеста
├── config.md                     # Хэштеги, курс, граница
│
├── news-digest-pipeline/
│   ├── src/
│   │   ├── index.js              # Express + auth + rate limiting
│   │   ├── middleware/auth.js    # Bearer + Basic Auth
│   │   ├── db/                   # SQLite (better-sqlite3)
│   │   ├── routes/               # API endpoints
│   │   ├── services/             # Claude API, publishers, queue
│   │   └── public/index.html    # Dashboard
│   ├── scripts/
│   │   ├── fb-publish.js         # Facebook Profile (Patchright)
│   │   ├── local-fetcher.js      # Chrome content extraction
│   │   └── monitor.sh           # VPS monitoring
│   ├── production/
│   │   └── image/                # Instagram image pipeline
│   ├── distribution/             # Platform-specific publishers
│   ├── docs/                     # Setup guides
│   ├── Dockerfile
│   └── docker-compose.yml
│
└── extension/                    # Chrome extension
```

---

## Документация

| Тема | Файл |
|------|------|
| Telegram (бот + канал) | [telegram-setup.md](news-digest-pipeline/docs/telegram-setup.md) |
| Facebook Page (Graph API) | [facebook-page-setup.md](news-digest-pipeline/docs/facebook-page-setup.md) |
| Facebook Profile (Patchright) | [facebook-setup.md](news-digest-pipeline/docs/facebook-setup.md) |
| VPS + Docker + Traefik | [vps-setup.md](news-digest-pipeline/docs/vps-setup.md) |
| iOS Shortcut | [ios-shortcut-setup.md](news-digest-pipeline/docs/ios-shortcut-setup.md) |
| Instagram Pipeline | [instagram/README.md](news-digest-pipeline/instagram/README.md) |
| Video Pipeline | [distribution/video/README.md](news-digest-pipeline/distribution/video/README.md) |

---

## Стек

| Компонент | Технология |
|-----------|-----------|
| Backend | Node.js 20, Express, SQLite |
| AI | Claude API (Opus 4), Anthropic SDK |
| Images | fal.ai, Recraft V3, Sharp |
| Video | Kling 3.0, Veo 3.1, FFmpeg |
| Browser | Patchright (stealth Playwright) |
| Deploy | Docker, Traefik, Ubuntu 24.04 |
| Notifications | Ntfy.sh |

---

## Лицензия

MIT
