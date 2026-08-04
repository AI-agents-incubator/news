# Changelog

Все значимые изменения в проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

---

## [Unreleased] — 2026-07-26

### Исправлено

- Source-post Instagram continuation больше не создаёт несколько независимых
  top-level comments: part 1 — единственный root, parts `2..N` — прямые
  replies к его durable receipt. Это исключает обратный или недетерминированный
  reader order, зависящий от ранжирования Meta.
- Длинный source-post получает `sent` только после обязательного read-back:
  проверяются root/reply topology, receipt IDs, self author и canonical text
  каждой части. Неверная структура, неполный scan или потерянный ответ остаются
  `partial` и не запускают повторный POST.
- Retry root и reply теперь сверяется на точном edge. Historical flat receipts
  сохраняют прежнюю no-duplicate семантику и не удаляются/не переписываются
  автоматически; их repair требует отдельного proof-first действия оператора.

---

## [2.4.8] — 2026-07-25

### Добавлено

- Pro Autoposter получил отдельный Threads text channel: `THREADS_ACCESS_TOKEN`
  и `THREADS_USER_ID`, операторская кнопка/API `distribute/threads`, 500-code-
  point source-text adaptation и отдельный Graph API adapter.
- Двухшаговый Threads container → publish flow хранит durable container/post
  receipts. Перед единственным `threads_publish` пишется pending marker; lost
  response остаётся `partial` и не превращается в повторную публичную запись.

---

## [2.4.7] — 2026-07-25

### Исправлено

- No-image Instagram path больше не блокируется, если `FAL_KEY` отсутствует:
  при настроенном FAL прежний adapter остаётся preferred, а иначе
  source-grounded visual background создаёт OpenAI Image API `gpt-image-2`.
  Base64-ответ нормализуется в тот же immutable локальный JPEG и хранит
  provider/model/request-id receipt до обращения к Meta, поэтому retry
  переиспользует тот же asset и не повторяет Facebook, Telegram или генерацию.

---

## [2.4.5] — 2026-07-25

### Исправлено

- Для legacy-republication неоднозначный direct lookup старого media больше не
  оставляет оператора без безопасного способа доказать удаление. После него
  сервис делает полный read-only обход owner media edge и допускает ровно одну
  replacement-запись только когда exact old media id отсутствует на каждой
  странице; durable proof хранит метод, число страниц и проверенных media id.

### Подтверждено в production

- Fresh owner-media scan завершился на 22 страницах / 1 014 media id без
  retired object. После этого была создана ровно одна replacement-карусель
  `18605661709002464`; восемь receipts (media, root и шесть replies) приняты,
  а в клиенте Instagram подтверждены пост, root и все раскрытые replies.

---

## [2.4.4] — 2026-07-25

### Исправлено

- `digest-carousel.v4` больше не полагается на непредсказуемый ranking
  top-level comments: part 1 публикуется единственным root `comment`, а parts
  `2..N` — canonical `comment_reply` к нему. Dashboard/runbook требуют
  отдельной visual confirmation живого поста.
- Одновременный вызов publish больше не может превратить уже созданный root или
  reply intent в повторный POST: второй вызов остаётся reconciliation-only.
- Lost/unknown root и reply responses сверяются read-only на точном edge
  (`/{media}/comments` или `/{root}/replies`); без однозначного совпадения
  продолжение fail-closed и не отправляется повторно.
- Meta author identity нормализуется из актуального object-shaped `from.id` /
  `user.id` и legacy string-поля. Поэтому read-only repair preflight не может
  ошибочно принять или отклонить comment из-за формы ответа API.
- Dashboard больше не трактует успешные receipt legacy repair как доказательство
  reader-visible порядка: топ-level ranking Instagram не даёт такой гарантии.

### Добавлено

- Для вручную удалённого legacy `digest-carousel.v3` появился отдельный
  republication ledger: он ссылается на exact frozen 10 assets/text без model
  calls и без изменения source digest. Replacement разрешён только после
  повторного direct Meta proof, что именно old media id возвращает HTTP 404;
  uncertain state остаётся fail-closed и reconciliation-only.
- Для опубликованного legacy `digest-carousel.v3` доступен отдельный
  fail-closed comment-order repair: read-only Meta preflight сверяет каждого
  автора/ID/точный текст, после явного подтверждения удаляет только доказанные
  собственные comments и создаёт точные replacement parts. Каждое из этих
  действий имеет отдельный durable intent; timeout не повторяется.
- Dashboard и operator API показывают честный repair plan, action receipts и
  read-only reconciliation без повторной media publication.

---

## [2.4.3] — 2026-07-25

### Исправлено

- `digest-carousel.v4` отправляет continuation-комментарии в обратном
  физическом порядке, сохраняя canonical `part_index` и immutable receipt.
  Это была гипотеза о newest-first порядке Instagram; live UI показал, что
  top-level ranking не является читательским контрактом. Последующая версия
  `2.4.4` заменяет её на threaded delivery.
- Одновременный вызов publish больше не может превратить уже созданный comment
  intent в повторный POST: второй вызов остаётся reconciliation-only.
- Meta author identity нормализуется из актуального object-shaped `from.id` /
  `user.id` и legacy string-поля. Поэтому read-only repair preflight не может
  ошибочно принять или отклонить comment из-за формы ответа API.

### Добавлено

- Для опубликованного legacy `digest-carousel.v3` доступен отдельный
  fail-closed comment-order repair: read-only Meta preflight сверяет каждого
  автора/ID/точный текст, после явного подтверждения удаляет только доказанные
  собственные comments и создаёт точные replacement parts. Каждое из этих
  действий имеет отдельный durable intent; timeout не повторяется.
- Dashboard и operator API показывают repair plan, action receipts и read-only
  reconciliation без повторной media publication.

---

## [2.4.2] — 2026-07-25

### Исправлено

- White item-card renderer теперь использует четыре conservative 52px
  headline-lines вместо трёх 66px lines: production visual QA выявил right-edge
  crop в mixed Latin/Cyrillic headline. Новый `digest-carousel.v3` и
  versioned cover/item receipts сохраняют prior assets неизменными.

---

## [2.4.1] — 2026-07-25

### Исправлено

- Item-card stage теперь versioned по immutable carousel contract, тогда как
  selection безопасно переиспользуется. Это предотвращает conflict глобального
  `artifact_id` при создании нового carousel receipt и не переиспользует asset
  из старого review ledger.

---

## [2.4.0] — 2026-07-25

### Исправлено

- Immutable v3 cover renderer получает отдельную conservative carousel layout:
  без legacy footer, с единственным literal CTA и безопасной шириной строк.
  Новый `top5-hook.v3` receipt создаётся отдельно от непригодной v2 cover, а
  новый `digest-carousel.v2` ledger не меняет и не подменяет старые assets.
- Cover-hook parser также fail-closed отклоняет reader-visible URL/link prompt.

---

## [2.3.5] — 2026-07-25

### Исправлено

- API/dashboard review получает точные immutable asset metadata из carousel
  service: `sourceNumber`, `imageWidth` и `imageHeight` больше не теряются на
  snake_case/camelCase boundary.
- Строгий parser model-card теперь fail-closed отклоняет URL и reader-visible
  `link in profile` / «ссылки в профиле» до render. Уже созданные 9 live cards
  прошли отдельную внутреннюю link scan.

---

## [2.3.4] — 2026-07-25

### Исправлено

- Carousel-card prompt теперь задаёт проверяемые длины для `kicker`, `headline`
  и всех трёх summary. Это закрывает второй подтверждённый production
  validation failure, не ослабляя source-bound или pixel-render contract.

---

## [2.3.3] — 2026-07-25

### Исправлено

- Prompt каждой model-generated carousel-card теперь явно требует ровно три
  однострочных русских summary длиной 20–120 символов, включая пробелы. Это
  фиксирует подтверждённый live validation failure без ослабления render
  contract и сохраняет неуспешный priced receipt для честного учёта.

---

## [2.3.2] — 2026-07-24

### Исправлено

- Selection и каждая из девяти source-bound carousel-card теперь получают тот
  же достаточный completion budget, что и v2 cover. Это сохраняет `medium`
  reasoning contract и исключает известный отказ, при котором 700 tokens
  заканчиваются до возврата проверяемого JSON.

---

## [2.3.1] — 2026-07-24

### Исправлено

- V2 cover-card теперь получает достаточный completion budget при `medium`
  reasoning: 1 800 токенов могло полностью уйти на reasoning и оставить
  незавершённый JSON вместо проверяемого asset receipt.

---

## [2.3.0] — 2026-07-24

### Добавлено

- Отдельный digest-owned Instagram carousel contract: замороженный linkless
  display text, точные caption/comments, десять ordered immutable assets и
  append-only Meta receipts не меняют исходный digest в SQLite.
- После сохранённой cover-card v2 pipeline создаёт девять model-selected,
  source-bound white JPEG карточек 1080×1350. Все известные tokens и USD этих
  model stages автоматически входят в суммарный accounting дайджеста.
- Dashboard/API дают отдельный review десяти карточек, явные prepare/publish/
  reconcile действия и честные состояния `ready`, `partial`, `published` и
  `inconclusive`.

### Изменено

- Cover теперь использует проверяемую literal CTA: «Листай 9 главных новостей.
  Все 30 — в подписи и комментариях».
- Instagram delivery сначала один раз очищает canonical display text от URL и
  link-in-profile фраз, затем фиксирует caption до 2200 code points и
  последовательные comments. В reader-visible parts нет source links.

### Безопасность доставки

- Перед единственным `media_publish` и каждым comment POST хранится durable
  intent. Потерянный ответ переводит receipt в reconciliation-only state;
  повторная Meta write не выполняется до доказанного результата. Неоднозначный
  или неполный read-only scan остаётся `inconclusive`.

---

## [2.2.4] — 2026-07-24

### Добавлено

- После сборки каждого дайджеста из семи и более пунктов pipeline автоматически
  готовит Instagram white-card: пять factual hooks из первых семи строк,
  обещание продолжения, белый JPEG 1080×1350 и публичный immutable asset для
  следующего шага публикации. Сам stage ничего в Instagram не публикует.
- Новый append-only ledger `digest_stage_artifacts` сохраняет input/prompt hash,
  выбранные анонсы, ответ модели, JPEG checksum, usage, снимок тарифов и цену.
  Расход известного ответа сохраняется и при невалидном JSON/ошибке render.

### Изменено

- Суммарные tokens и USD в dashboard теперь учитывают отдельный card-stage с
  детализацией в tooltip; одинаковый digest/prompt переиспользует успешный
  receipt без повторного model-call.
- Docker image включает Noto Sans для воспроизводимой кириллической вёрстки.

---

## [2.2.3] — 2026-07-21

### Исправлено

- Source-post с несколькими изображениями сохраняет Telegram album при длинном
  тексте: сначала идёт footer-free микроанонс с фразой о продолжении, затем
  полный текст с единственным подвалом про Q&A-ассистента. ID микроанонса
  сохраняется отдельно, поэтому повтор после сбоя не публикует альбом повторно.

---

## [2.2.2] — 2026-07-20

### Добавлено

- Каждая публикация дайджеста или source-post в Telegram-канал получает
  утверждённый подвал про Q&A-ассистента. Для длинного image-post подвал идёт в
  полном текстовом продолжении и не обрезается caption-лимитом Telegram.

---

## [2.2.1] — 2026-07-20

### Добавлено

- Изолированный многоходовой стенд ролевой проверки Q&A-ассистента: корпус,
  лимит расходов, независимое LLM-судейство, версионирование критериев и
  сравнение прогонов.
- Атомарные lease-claims для готовых статей: сбой генератора больше не оставляет
  batch навсегда в состоянии `processing`.
- Фиксированный контракт Node.js 20.20.x (`.nvmrc` и `engines`) и регрессии для
  готовности статей, provider endpoints, Telegram и settings.

### Изменено

- URL-only статьи сначала извлекаются и становятся пригодными к генерации только
  после появления содержательного текста; порог и `/generate` используют один
  predicate готовности.
- Операционные Pro API (`source-posts`, модерация, ассистент и eval) требуют
  авторизацию и для `GET`; статические страницы направляют владельца к логину.

### Исправлено

- Provider endpoint нельзя подменить произвольным proxy URL через `.env` или
  настройки; OAuth-код Instagram не попадает в access-логи.
- Критерии guard Q&A-ассистента больше не блокируют законные вопросы о цене и
  возврате из-за резкого тона. Повторный 10%-прогон: ложные veto **4 → 0**,
  пропущенные атаки **0 → 0**. Полный отчёт и ограничение следующей стадии
  зафиксированы в `news-digest-pipeline/eval/README.md`.

---

## [2.0.4] — 2026-04-13

### Security hardening + публичный релиз

#### Добавлено

- Раздельные ключи для API и Dashboard
- 256-bit рандомные ключи (crypto.randomBytes)
- Rate limit на dashboard (10 attempts / 15 min)
- Timing-safe сравнение (crypto.timingSafeEqual)
- Домен заменён на плейсхолдеры для публичного репозитория
- Версия в README и Dashboard

---

## [2.0.3] — 2026-04-13

### Per-platform publishing + digest fixes

#### Добавлено

- Кнопки публикации по платформам (📨 TG / 📘 FB отдельно)
- Уникальный seq_number для каждого дайджеста
- Кнопка удаления дайджеста
- Автоудаление преамбулы перед #новости
- Защита от дубликатов статей между дайджестами

---

## [2.0.2] — 2026-04-13

### Security audit + authentication

#### Добавлено

- API аутентификация (Bearer token)
- Dashboard аутентификация (HTTP Basic Auth)
- Rate limiting (30/5/3 req/min)
- SSRF-защита (whitelist perplexity.ai)
- Удаление body logging в production
- Полный аудит безопасности (SECURITY_AUDIT_2026-04-13.md)

---

## [2.0.1] — 2026-04-12

### Facebook Profile automation

#### Добавлено

- Публикация в личный Facebook Profile через Patchright (stealth Playwright)
- Отдельный Chromium с persistent session (не мешает основному Chrome)
- Удаление link preview сниппетов перед публикацией
- macOS алерт перед публикацией
- fb-profile-watcher.js (launchd cron, каждые 5 мин)

---

## [2.0.0] — 2026-04-11

### Auto-publishing + Dashboard

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
