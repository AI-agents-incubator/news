# Instagram API: настройка публикации — рунбук и разбор ошибок

> Этот рунбук относится только к Instagram Login и будущей публикации через
> Graph API. Он не разрешает генерировать или публиковать cover assets. Текущий
> model-driven cover contract и его no-publish boundary —
> [`instagram/cover-lab/README.md`](../instagram/cover-lab/README.md).

**Дата:** 2026-07-19 · **Статус:** пройдено до конца, токен с правом публикации получен
**Затрачено:** ~6 часов и одна временная блокировка веб-доступа. **Должно занимать ~20 минут.**
Разница между этими числами — содержание этого документа.

Аккаунт: `alexeykrol` (Instagram Creator) · Задача: публиковать в свой IG программно из пайплайна.

---

# ЧАСТЬ A. Правильная последовательность

> Порядок здесь **не косметический**. Почти каждая наша потеря времени — следствие
> нарушения этого порядка. Если повторяешь настройку — иди строго по пунктам.

## A0. Определиться с путём API (до всего остального)

У Meta **два разных** пути к Instagram, и они несовместимы по токенам и хостам:

| | Instagram API **with Facebook Login** | Instagram API **with Instagram Login** ← мы здесь |
|---|---|---|
| Хост API | `graph.facebook.com` | **`graph.instagram.com`** |
| Токен | Page access token | **Instagram User token** (`IGAA…`) |
| Требует | связку с Facebook-страницей | только professional-аккаунт IG |

Мы выбрали **Instagram Login** (решение владельца: «никакого Facebook-логина»).
Всё ниже — только про этот путь. Код адаптера: `src/pro/services/instagram.js`.

## A1. Приложение и use case

- Facebook App: **NewsDigest**, App ID `2100574570484573`
- Внутри — Instagram-приложение со **своими** ID/секретом: App ID `1520130979241548`
- Use case: управление контентом/сообщениями Instagram

⚠️ **Instagram app ID ≠ Facebook app ID.** Это разные пары «ID + секрет». В OAuth
идёт **Instagram**-пара.

## A2. Выдать приложению ВСЕ нужные права — ДО генерации любых токенов

Страница прав (`Permissions and features`), нужны все пять:

```
instagram_business_basic             — читать профиль и медиа
instagram_business_content_publish   — ПУБЛИКОВАТЬ            ← ключевое
instagram_business_manage_comments   — комментарии (продолжение длинной подписи)
instagram_business_manage_insights   — аналитика (на будущее)
instagram_business_manage_messages   — директ (требуется messaging-use-case'ом)
```

Все должны быть в статусе **«Ready for testing»** — это Standard Access, ревью не требует.

> ⚠️ **ЛОВУШКА 1.** Список прав, который use case показывает в шаге «Add required
> permissions», — это только **обязательный для messaging** набор, и `content_publish`
> в него **не входит**. Не считай этот список полным: смотри страницу прав целиком.

> ⚠️ **ЛОВУШКА 2 (наблюдение владельца).** Заход на страницу прав, судя по всему,
> **инвалидирует уже выпущенный токен**. Поэтому: сначала все правки прав, токены — **в самом конце**.

## A3. Что из шагов use case делать НЕ надо

| Шаг | Нужен? | Почему |
|---|---|---|
| Configure webhooks | ❌ | Вебхуки — входящие события, публикация исходящая. Плюс требует published state, сейчас и не выполнить |
| **Complete app review** | ❌ | Только для **чужих** аккаунтов. Meta разрешает пропустить прямым текстом — см. ниже |

**Самое надёжное доказательство — надпись самой Meta в шаге 5 дашборда:**

> «Instagram requires successful completion of the app review process before your app can
> access live data… **You can skip this step if you're a direct developer who only builds
> for your own Instagram businesses and don't plan to create solutions for clients.**»

То есть Meta сама разрешает пропустить шаг тем, кто строит для **своих** аккаунтов и не
делает решений для клиентов. Читать надо весь абзац: первая фраза пугает, последняя разрешает.

Оба шага так и останутся серыми в дашборде **навсегда**. **Это нормально, а не «недоделано»,
и от этого ничего не «слетает»:** незакрытый необязательный шаг ничего не отзывает и не ломает.
Уже выданный токен продолжает работать. Дашборд просто показывает полный список для общего
случая — обслуживания чужих бизнесов.

## A4. Поднять redirect endpoint — ДО регистрации URL в Meta

Нужен HTTPS-адрес на своём домене, который **отдаёт 200**.

У нас: `GET /ig-oauth/callback` в `src/pro/index.js` →
`https://news.questtales.com/ig-oauth/callback`

Контракт эндпоинта:
- **всегда 200**, включая заход без параметров (это состояние на момент регистрации — не должен выглядеть сломанным);
- **ничего не хранит и не логирует** — код авторизации это одноразовый секрет со сроком ~1 час;
- **HTML-экранирование всех query-параметров** — публичный GET, иначе reflected XSS;
- **публичный**, вне авторизации — Meta редиректит неаутентифицированный браузер.

> **Почему настоящий эндпоинт, а не 404.** Дока Meta **молчит** о том, проверяет ли она
> доступность redirect-адреса при сохранении: нет ни требования «должен отдавать 200»,
> ни утверждения об обратном. На недокументированном поведении не строимся. Бонус:
> страница показывает код читаемо, вместо выковыривания из адресной строки.

Порядок именно такой: **сначала эндпоинт живой, потом регистрируем**.

## A5. Зарегистрировать redirect URL

`Set up Instagram business login` → **Redirect URL** → сохранить.

> ⚠️ **ЛОВУШКА 3.** Дока предупреждает: *«the App Dashboard may have added a trailing
> slash to your URIs, so we recommend that you verify by checking the list»*.
> Совпадение должно быть **символ в символ**. У нас сохранилось **без** слэша — проверено
> в `Business login settings` → `OAuth redirect URIs`.

Поля `Deauthorize callback URL` и `Data deletion request URL` — **оставить пустыми**,
они нужны только для app review, который мы не подаём.

## A6. Забрать Instagram app secret

Пара `Instagram app ID` / `Instagram app secret` (кнопка **Show**) — **вверху страницы
`API setup with Instagram login`, НАД шагами**.

> ⚠️ **ЛОВУШКА 4.** Дока указывает путь `… → Business login settings → Instagram app secret`,
> но в реальном интерфейсе этот диалог содержит **только три поля** (redirect URIs,
> deauthorize URL, data deletion URL) — секрета там нет. **Дока разошлась с UI.** Ищи
> визуально пару ID/секрет с кнопкой Show, а не по пути из доки.

## A7. Пройти авторизацию

Дашборд сам генерирует **Embed URL** (шаг business login). Формат:

```
https://www.instagram.com/oauth/authorize
  ?force_reauth=true
  &client_id=<INSTAGRAM_APP_ID>
  &redirect_uri=<точно тот, что зарегистрирован>
  &response_type=code
  &scope=instagram_business_basic,instagram_business_manage_messages,
         instagram_business_manage_comments,instagram_business_content_publish,
         instagram_business_manage_insights
```

**Перед открытием — проверь глазами, что `content_publish` есть в `scope`.**
Если его там нет — возвращайся к A2, иначе токен снова не сможет публиковать.

Открыть в браузере → войти → подтвердить **все** права → редирект на наш endpoint,
он покажет код.

## A8. Обменять код на токен — ОДНОЙ операцией, сразу с сохранением

⏰ Код живёт **~1 час** и **одноразовый**.

```bash
# 1) код → короткий токен
POST https://api.instagram.com/oauth/access_token
     client_id, client_secret, grant_type=authorization_code, redirect_uri, code
# ответ: {"access_token":"…","user_id":…,"permissions":[…]}

# 2) короткий → долгоживущий (60 дней)
GET  https://graph.instagram.com/access_token
     ?grant_type=ig_exchange_token&client_secret=…&access_token=<короткий>
# ответ: {"access_token":"…","token_type":"bearer","expires_in":5132879}
```

> ✅ **ГЛАВНЫЙ ПРИЁМ.** Ответ на обмен **сам содержит поле `permissions`** — список
> реально выданных прав. Это значит: **проверять scope запросами к API не нужно и нельзя.**
> Смотри `permissions` в ответе. Именно попытка «проверить токен по слоям» вручную
> и вызвала инцидент из части B.

> ⚠️ **ЛОВУШКА 5 (наша).** Мы сделали обмен, замаскировали токен в выводе ради
> безопасности — и **не записали его в файл**. Переменные оболочки между вызовами не
> живут → токен потерян → код одноразовый → пришлось заново проходить авторизацию.
> **Получил секрет — сохрани в том же действии.**

## A9. Сохранить

Локальный `.env` (в gitignore, `chmod 600`):

```
INSTAGRAM_ACCESS_TOKEN=<долгоживущий>
INSTAGRAM_ACCOUNT_ID=17841400766950431
INSTAGRAM_APP_ID=1520130979241548
INSTAGRAM_APP_SECRET=<секрет>
```

> ⚠️ **ЛОВУШКА 6.** В ответе обмена `user_id` = `27684033047928955` — это **app-scoped**
> идентификатор. Для публикации нужен **IG account id `17841400766950431`**. Перепутать
> легко, они оба «user id».

---

# ЧАСТЬ B. Разбор инцидента: как мы уронили веб-доступ

## Что случилось

Настройка была **не закончена** (шаг business login не пройден, токен из
dashboard-кнопки не имел `content_publish`). Вместо того чтобы довести регистрацию до
конца, ассистент начал **диагностировать токен вручную** — серией запросов к
`graph.instagram.com` (`/me`, `/media`, `content_publishing_limit`, создание контейнера).

**Instagram расценил это как «вход с нового устройства»** и поднял security-alert.
Последствия:

- `facebook.com` и `developers.facebook.com` перестали открываться **во всех десктопных браузерах** («Account Temporarily Unavailable»);
- пришли security-уведомления в IG-директ и на почту;
- **мобильное приложение, лента Instagram и Threads при этом работали** → аккаунт **не был заблокирован**;
- отпустило само примерно через час после прекращения запросов.

## Настоящая причина

Первое обращение любого API-клиента с токеном Instagram видит как **новое устройство** —
**даже с машины и сети владельца**. В списке сессий это выглядело как
«Apple Macintosh, Santa Clara» — то есть та же локация, что и у собственного телефона
владельца. Это ожидаемое поведение при начале работы с API, не признак взлома.

Ошибкой была **не сама работа с API**, а **ручное «прощупывание» вместо завершения настройки**.

## Что делать при таком alert'е

| ✅ Делать | ❌ НЕ делать |
|---|---|
| «Это был я» (если кнопка есть) | **«Recover now» / «Secure account»** — это ветка «меня взломали»: сброс пароля, глобальный разлогин, отзыв всех токенов |
| Прекратить активность и **подождать** | Массовый выход из сессий — сигнал «была угроза», может продлить защитное состояние |
| Проверить, что мобильное работает (значит аккаунт цел) | Менять пароль в панике |

## Диагностические ошибки ассистента (все — необоснованные утверждения)

Пока веб не пускал, было выдано подряд **четыре ложных диагноза**, каждый стоил
владельцу действий:

1. **«Виноват VPN»** → VPN был выключен.
2. **«Виновато расширение браузера»** → расширений почти нет, и Instagram/Threads из тех же браузеров работали.
3. **«Виноваты куки facebook.com»** → чистка и свежий логин не помогли.
4. **«Права `content_publish` нет в приложении»** → оно было на месте. **Проверка этого утверждения заставила зайти на страницу прав, что инвалидировало свежий токен.**

Признак, который всё это время указывал на верный ответ и был проигнорирован:
**работало всё, кроме `facebook.com` в вебе** — при живых мобильном, Instagram и Threads.
Такая выборочность означает состояние на стороне аккаунта/сервиса, а не поломку у клиента.

## Выводы

1. **Довести регистрацию до конца, потом трогать API.** Не диагностировать незаконченную настройку.
2. **Scope проверять из ответа на обмен**, а не запросами к API. Ответ и так его содержит.
3. **Не утверждать непроверенное.** Не сверено с докой или экраном → «не знаю», а не правдоподобная версия.
4. **Не гонять владельца по проверкам своих догадок.** Каждая такая проверка — его время и риск.
5. **Токены генерировать последними**, после всех правок прав.
6. **Получил секрет — сохрани тем же действием.**

---

# ЧАСТЬ C. Проверенная справка

## Ключевые параметры

| Параметр | Значение |
|---|---|
| База API | `https://graph.instagram.com` |
| Версия | `v25.0` |
| IG account id (для публикации) | `17841400766950431` |
| app-scoped user_id (НЕ для публикации) | `27684033047928955` |
| Instagram app ID | `1520130979241548` |
| Facebook app ID | `2100574570484573` |
| Redirect URI | `https://news.questtales.com/ig-oauth/callback` |
| Срок долгоживущего токена | ~60 дней (получено 5 132 879 сек ≈ 59.4 дн) |

## Публикация (container → publish)

```
POST /{ig-account-id}/media          {image_url, caption}  → creation_id
GET  /{creation_id}?fields=status_code   (опрашивать до FINISHED)
POST /{ig-account-id}/media_publish  {creation_id}         → media id
POST /{media-id}/comments            {message}   ← только part 1, root ветки
POST /{ig-comment-id}/replies        {message}   ← parts 2..N, ответы root
GET  /{media-id}/comments?fields=id,text,timestamp,user,from  ← сверка после сбоя
GET  /{ig-comment-id}/replies?fields=id,text,timestamp,user,from  ← сверка reply после сбоя
```
Реализация с ретраями и таймаутами: `src/pro/services/instagram.js`.
Ограничения: caption и каждый комментарий ≤ 2200 символов (разбивка —
`src/pro/services/ig-text.js`), картинка JPEG по публичному https, ≤ 100 постов
за 24 часа. Если подпись длиннее лимита, публикация создаётся один раз, а хвост
идёт одной веткой: part 1 — единственный top-level comment, а следующие части
— прямые replies к нему. В `source_posts` сохраняются `instagram_media_id`,
упорядоченный JSON-массив `instagram_comment_ids` (root, затем replies),
`instagram_comment_thread_contract`, временный
`instagram_comment_pending_index` и отдельный read-only verification receipt.
Перед единственной отправкой каждой части сохраняется pending-index. Если
ответ POST потерян, pipeline читает либо `/comments` для root, либо только
`/{root-id}/replies` для reply и принимает одно точное совпадение текста от
нашего IG User ID (`user === INSTAGRAM_ACCOUNT_ID`).

После всех POST канал **не** получает `sent` только по ID: read-back проверяет
точный self-authored root по media comments edge и каждого receipt-proven reply
по отдельному edge этого root. `/root/replies` Meta может не вернуть author
поле: тогда reply доказывается immutable ID из нашего authenticated POST receipt
и exact canonical text; если API вернул автора, он также обязан совпасть. Media comments edge Meta может возвращать replies
в плоском списке, поэтому он не используется как доказательство parentage или
визуального порядка. Meta наблюдалась схлопывающей двойной пробел прямо перед URL;
pipeline канонизирует только этот известный auto-link separator ещё до POST,
а не ослабляет проверку произвольной нормализацией текста. При нескольких
совпадениях, ошибке чтения, неполном сканировании или неверной topology статус
остаётся `partial`; повторный POST запрещён.

Historical flat receipts не переинтерпретируются автоматически и не удаляются
по retry. Незавершённый legacy delivery сохраняет старый edge только ради
защиты от дублей; исправление уже опубликованной ветки — отдельная явная
operator repair с предварительным доказательством каждого self-comment.
Оператор сначала запускает только чтение:

```bash
node scripts/repair-source-post-instagram-comment-thread.js \
  --post-id <source-post-uuid> --command preflight
```

Только состояние `ready` допускает отдельную подтверждённую запись:

```bash
node scripts/repair-source-post-instagram-comment-thread.js \
  --post-id <source-post-uuid> --command repair \
  --confirm REPAIR_SOURCE_POST_COMMENT_THREAD
```

Этот repair не вызывает `media_publish`; он удаляет только доказанные legacy
комментарии, создаёт один root/reply thread, и обновляет source receipt лишь
после final read-back. Unknown DELETE/POST не повторяется автоматически.
Нужны права `instagram_business_basic` и `instagram_business_manage_comments`.

### Карусель дайджеста: ручная проверка → явная публикация → сверка

Доставка дайджеста в Instagram — это отдельный fail-closed процесс, а не
статус `published` самого дайджеста. Оператор сначала явно вызывает
`POST /api/digests/:id/instagram-carousel/prepare`: локально готовится ровно
10 неизменяемых карточек 1080×1350 (обложка и девять source-bound карточек) и
сохраняются точные caption/comments. Этот шаг **никогда не публикует**. Перед
следующим действием оператор проверяет приватный review через
`GET /api/digests/:id/instagram-carousel`; он показывает все десять карточек
только после локальной проверки файлов. Все четыре carousel endpoint требуют
operator auth; неавторизованный запрос не может ни подготовить, ни опубликовать,
ни запустить remote reconciliation.

В тексте карточек, caption и каждом continuation comment не должно быть URL,
«link in profile» или «ссылки в профиле»: читатель получает весь digest внутри
Instagram. Неполный набор, неверный порядок, отсутствующий файл, неподтверждённый
размер или ссылка блокируют доставку — не допускаются placeholder, сокращённая
карусель и новая генерация при клике.

`part_index` хранит читательский порядок: caption, затем continuation `1..N`.
Для нового `digest-carousel.v4` publisher создаёт ровно один top-level receipt
`comment` для part 1, а parts `2..N` — отдельные receipt `comment_reply` на
`/{root-comment-id}/replies` в возрастающем каноническом порядке. Это не
опирается на ranking top-level comments: фактический порядок top-level в живом
Instagram наблюдался как недетерминированный. Parent root и каждый reply имеют
immutable intent до POST; timeout/unknown не повторяется, а reconciliation
читает либо media comments для root, либо replies только этого receipt-proven
root. После каждой реальной публикации требуется отдельная визуальная проверка
именно этого поста в Instagram — API receipt доказывает write/topology, но не
гарантирует presentation order клиента.

Для уже опубликованного legacy `digest-carousel.v3` есть отдельный repair, он
не создаёт новую media-карусель и не изменяет исходные receipts. Сначала
operator читает `GET /api/digests/:id/instagram-carousel/comment-order-repair`:
это read-only scan всех страниц Meta и сверка каждого исходного `remote_id`,
точного текста и self author. Только если plan вернул `ready` и
`source_proven=true`, operator явно подтверждает
`POST /api/digests/:id/instagram-carousel/comment-order-repair` с JSON
`{"confirm":"REPAIR_COMMENT_ORDER"}`. Перед каждым DELETE и replacement POST
создаётся отдельный immutable intent; удаляются только receipt-proven comments
нашего IG account, а replacement parts публикуются физически `N..1` при
сохранении logical `part_index` `1..N`. Это legacy repair, а не обещание
визуального порядка; новая публикация использует threaded v4 contract выше.
Timeout/неизвестный результат не
повторяется: только `POST .../comment-order-repair/reconcile` делает read-only
scan и может подтвердить отсутствие original или единственный exact self
replacement. Repair никогда не вызывает `media_publish`.

### Замена удалённого legacy-поста: отдельный delivery ledger

Если owner сам удалил ошибочно опубликованный `digest-carousel.v3`, это **не**
разрешает повторить его старый `media_publish` receipt. Сначала оператор может
локально выполнить `POST /api/digests/:id/instagram-carousel/republication/prepare`.
Он создаёт отдельный delivery ledger, который только ссылается на те же десять
неизменяемых v3 assets и frozen linkless text; source digest, source carousel,
original receipts, model calls и card cost не меняются. Если published v3 source
не ровно один или его local checksum/file/text evidence не exact, preparation
блокируется.

После ручного удаления operator читает
`GET /api/digests/:id/instagram-carousel/republication/retired-media-preflight`.
Это read-only `GET /{old-media-id}`: definite HTTP 404 сразу означает
`retired_media_state=missing`. Meta может вместо 404 вернуть неоднозначный HTTP
400 `Unsupported get request` (объект отсутствует **или** недоступен); он сам
по себе не даёт write. В этом случае сервис делает второй read-only обход
cursor-пагинированного `GET /{our-ig-account-id}/media` и принимает отсутствие
только если обход завершился без next cursor и exact old media id не найден.
401/403/5xx, timeout, malformed response, повтор cursor, лимит обхода или
успешный объект остаются соответственно `inconclusive`/`present` и не дают
write. Durable proof сохраняет метод, число проверенных страниц и media id.
Новая внешняя
попытка допускается только отдельным подтверждённым
`POST /api/digests/:id/instagram-carousel/republication/publish` с JSON
`{"confirm":"REPUBLISH_AFTER_OWNER_DELETE"}`. Непосредственно перед durable
`media_publish` intent сервис повторяет этот exact absence check и сохраняет
его proof.

Замена создаёт ровно одну новую media-карусель из тех же 10 assets, затем один
root comment для part 1 и replies `2..N` в каноническом порядке. Её receipts
принадлежат новому ledger; timeout/unknown оставляет `awaiting_reconciliation`.
`POST /api/digests/:id/instagram-carousel/republication/reconcile` выполняет
только read-only поиск exact media/root/reply и никогда не делает повторный
POST. После accepted/reconciled delivery всё равно нужна визуальная проверка
нового поста в клиенте Instagram: оператор сверяет саму новую карусель, root и
каждый раскрытый reply. Accepted receipt доказывает запись и topology, но не
заменяет эту визуальную проверку.

Для обычной, ещё не опубликованной карусели (не legacy-republication) отдельный
`POST /api/digests/:id/instagram-carousel/publish` делает одну явную внешнюю
попытку публикации. Когда ответ Meta потерян, частичен или неоднозначен,
повторная публикация запрещена: состояние остаётся `partial` либо
`awaiting_reconciliation`. Оператор может отдельно вызвать
`POST /api/digests/:id/instagram-carousel/reconcile`; это read-only сверка Meta, она
не создаёт container, comment или новую публикацию.

## Цитаты из доки (то, на что опирались)

**Про app review — ключевое:**
> «If your app only serves your Instagram professional account or **an account you manage**,
> **Standard Access is all your app needs**.»
> «Advanced Access is the access level required if your app serves Instagram professional
> accounts **that you don't own or manage**… Your app must complete Meta App Review to be
> granted Advanced Access.»
> — [Instagram Platform — Access Levels](https://developers.facebook.com/docs/instagram-platform/overview/)

Критерий Meta — **владение и роли**, а не тип операции. Публикация в свой аккаунт ревью не требует.
**Подтверждено фактом:** Meta выдала `instagram_business_content_publish` без всякого ревью.

**Про redirect URI:**
> «Make sure this **exactly matches** one of the base URIs in your list of valid OAuth URIs…
> This must be the same URI or we will reject the request.»
> «Keep in mind that the App Dashboard **may have added a trailing slash** to your URIs…»
> — [Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/)

Проверка — **сравнение строк в момент авторизации**, не HTTP-запрос при регистрации.
Wildcards и подпути не работают: регистрация корня НЕ покрывает `/что-то`.

**Про код авторизации:**
> «we will redirect your app user to your `redirect_uri` and pass you an Authorization Code
> through the `code` query string parameter» · код «is valid for 1 hour and can only be used once».
> К адресу дописывается `#_` — это фрагмент, на сервер не отправляется, при ручном копировании отрезать.

## Чего в доке НЕТ (не строить на этом)

- Проверяет ли Meta **доступность** redirect-адреса при сохранении.
- Требование HTTPS именно на страницах Instagram-login (есть только в общем разделе Facebook Login).
- Что происходит, если redirect-адрес отдаёт ошибку.
- Актуальное расположение **app secret** в интерфейсе (дока разошлась с UI — см. ЛОВУШКУ 4).

---

# ЧАСТЬ D. Эксплуатация

## Жизненный цикл токена

**Почему 60 дней, а не «навсегда».** У Instagram **нет** бессрочных токенов — это
сознательное решение Meta по безопасности: утёкший токен перестаёт работать сам.
Иерархия сроков:

| Тип | Срок | Как получить |
|---|---|---|
| Код авторизации | ~1 час, одноразовый | ручная авторизация в браузере |
| Короткий токен | ~1 час | обмен кода |
| **Долгоживущий токен** | **60 дней** | обмен короткого (`ig_exchange_token`) |

**Но проходить авторизацию заново каждые 60 дней НЕ надо.** Долгоживущий токен
**продлевается программно**, без участия человека и без браузера:

```
GET https://graph.instagram.com/refresh_access_token
    ?grant_type=ig_refresh_token&access_token=<текущий долгоживущий>
→ новый токен ещё на 60 дней
```

Условия: токену не меньше **24 часов** и он **ещё не истёк**.

Практический вывод: **поставить фоновое продление** (например, раз в 30 дней) — и токен
живёт бесконечно, ручная авторизация больше не нужна никогда. Ручной путь (части A7–A8)
понадобится снова **только если** продление пропущено дольше 60 дней и токен успел умереть.

- Текущий токен истекает **~2026-09-16**.
- ⬜ **Автопродления пока НЕТ** — открытая задача, и она важнее, чем кажется:
  просроченный токен = **тихо умерший канал публикации**, без ошибки на видном месте.
- Точный набор параметров `refresh_access_token` сверить по доке в момент реализации
  (нужен ли `client_secret` — не проверяли).

## Безопасность

- **App secret — постоянный пароль приложения.** Наш засветился в переписке при настройке →
  **перевыпустить** и положить новый сразу в прод-`.env`, минуя чат.
- Токен и секрет — только в `.env` (gitignore, `chmod 600`). Никогда в код, коммиты и логи.
- Redirect-эндпоинт **не логирует** код авторизации намеренно: это одноразовый секрет.

## Правило работы с аккаунтом владельца

**Любое действие с аккаунтом, токеном или API — только с явного разрешения владельца
на конкретное действие.** Не «в целом разрешено», а каждый раз. Причина — часть B.

---

## Статус на 2026-07-19

✅ Настройка завершена, долгоживущий токен с `content_publish` получен и сохранён локально.
⬜ Токен не выкачен на прод.
⬜ Тестовая публикация не проводилась (Фаза 1: тестовая картинка 1080×1080 + текст + хвост в коммент).
⬜ Автопродление токена не сделано.
⬜ App secret не перевыпущен после засветки.
