# Changelog

Все значимые изменения в проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

---

## [1.0.0] — 2026-04-13

### Первый публичный релиз

#### Добавлено

- **Сбор новостей**: Telegram-бот принимает URL от пользователя, Chrome Extension для пакетной загрузки
- **Генерация дайджестов**: 2-фазная генерация через Claude API (Opus 4) — комментарии + сборка
- **Dashboard**: веб-интерфейс для управления дайджестами (просмотр, копирование, публикация, удаление)
- **Публикация в Telegram**: Bot API, автоматическая разбивка на части по 4096 символов
- **Публикация в Facebook Page**: Graph API v19.0, Page Access Token
- **Публикация в Facebook Profile**: browser automation через Patchright (stealth Playwright fork)
- **Обогащение контента**: local-fetcher.js — извлечение контента через Chrome + AppleScript (обход Cloudflare)
- **Queue Manager**: автоматическая генерация при 13+ статьях
- **Push-уведомления**: Ntfy.sh
- **Docker**: Dockerfile + docker-compose.yml с Traefik reverse proxy
- **iOS Shortcut**: отправка URL через Share Sheet

#### Безопасность

- API аутентификация (Bearer token)
- Dashboard аутентификация (HTTP Basic Auth, отдельный пароль)
- Rate limiting: 30 req/min (API), 5/min (publish), 3/min (generate), 10 attempts/15min (dashboard)
- SSRF-защита: whitelist только perplexity.ai
- Timing-safe сравнение ключей (crypto.timingSafeEqual)
- Полный аудит безопасности (SECURITY_AUDIT_2026-04-13.md)

#### Медиа-пайплайны (в разработке)

- **Instagram**: генерация заголовков (5-step method, Opus 4), наложение текста на шаблоны (Sharp)
- **Video**: исследование завершено (Kling 3.0, Veo 3.1, Seedance 2.0)
- **Audio**: placeholder

#### Документация

- Настройка Telegram (бот + канал)
- Настройка Facebook Page (Graph API, получение токена)
- Настройка Facebook Profile (Patchright, обход bot detection)
- Настройка VPS (Docker, Traefik, мониторинг)
- iOS Shortcut
- Mermaid-диаграммы архитектуры в README

---

## [0.1.0] — 2026-04-03

### Прототип

#### Добавлено

- Базовая структура проекта
- SQLite схема (articles + digests)
- Express API skeleton
- Chrome Extension для сбора статей с Perplexity
- Промпты: prompt.md, assembly_prompt.md, config.md
