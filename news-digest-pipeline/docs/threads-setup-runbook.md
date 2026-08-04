# Threads API: настройка и безопасная публикация

**Статус:** text-post delivery и owner-only OAuth connection flow реализованы и
развёрнуты в pro Autoposter. Первая успешная авторизация владельца и первая
публикация остаются двумя отдельными production gates.

## 1. Что нужно подготовить в Meta

В Meta app должен быть включён Threads API / publishing use case. Для OAuth
token владельца нужны как минимум разрешения:

```text
threads_basic
threads_content_publish
threads_delete
```

`threads_delete` нужен для безопасного smoke-test: технический пост создаётся,
проверяется и удаляется через API. Без этого scope тестовый post не создаётся,
потому что гарантированная очистка невозможна.

Используйте актуальную официальную [Threads API collection Meta](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api?entity=request-34203612-ee0a2365-9d95-4cbe-8087-1cfb04d38c05), чтобы сверить scope до первой боевой
отправки. Не передавайте App Secret, token или user id в issue, лог или чат.

Для серверного OAuth в защищённом production environment нужны:

```dotenv
THREADS_APP_ID=<Threads App ID>
THREADS_APP_SECRET=<Threads App Secret>
```

Шифрование OAuth credentials дополнительно использует уже существующий
`API_SECRET_KEY` (или `DASHBOARD_PASSWORD`, если API key не задан). Значение
секрета не хранится в SQLite.

Существующие ручные credentials остаются допустимым bootstrap/fallback:

```dotenv
THREADS_ACCESS_TOKEN=<existing long-lived token>
THREADS_USER_ID=<existing Threads user id>
```

После успешного OAuth новые token и user id сохраняются зашифрованно в
постоянной SQLite и имеют приоритет над ручными значениями. Пустые
`THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` допустимы после завершённого OAuth.

## 2. Callback URLs (шаг 3)

Threads использует отдельный redirect endpoint; Instagram callback для него не
переиспользуется. В Meta должен быть сохранён точный URL:

```text
https://news.questtales.com/api/oauth/threads/callback
```

Контракт:

- прямое открытие всегда возвращает `200`, чтобы зарегистрированный redirect не
  выглядел сломанным;
- OAuth `code`, token, App Secret и user id не отражаются в HTML и исключены из
  HTTP request-логов;
- ответ запрещено кэшировать и индексировать;
- redirect URI в настройках Meta, authorization URL и запросе обмена кода
  совпадает символ в символ.

## 3. Owner-only OAuth (шаг 5)

После развёртывания владелец входит в защищённую страницу
`/syndication.html` и нажимает **«Подключить Threads»**:

1. `POST /api/oauth/threads/connect` создаёт случайный одноразовый `state`.
   В SQLite хранится только SHA-256 hash; срок жизни — 10 минут.
2. Браузер переходит на `https://threads.net/oauth/authorize` с
   `threads_basic,threads_content_publish`.
3. Meta возвращает одноразовый `code` на точный callback URL. Callback сначала
   атомарно поглощает `state`; неизвестный, истёкший или повторный `state`
   отклоняется до любого запроса к Meta.
4. Сервер обменивает `code` на short-lived token, затем на long-lived token и
   проверяет владельца через `/v1.0/me`. Первый `POST /oauth/access_token`
   передаёт параметры в query string и оставляет body пустым — это точный
   контракт текущей официальной Threads collection Meta. Точный `user id`
   берётся из аутентифицированного ответа `/me`: Meta может сериализовать
   значение `user_id` первого ответа как JSON number, превышающий безопасную
   целочисленную точность JavaScript.
5. Token, user id и срок действия сохраняются одним AES-256-GCM ciphertext в
   постоянной SQLite. Открытые значения не возвращаются в браузер.

Если обмен прерывается, предыдущие credentials не перезаписываются. Status API
сообщает только состояние подключения, источник и срок действия — без token и
user id.

## 4. Проверка Access Token Debugger

После получения token и до первой публикации Meta рекомендует проверить его в
[официальном Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
или эквивалентным серверным запросом `GET /debug_token`. Проверяются:

- `is_valid`;
- наличие `threads_basic`, `threads_content_publish` и `threads_delete`;
- непросроченный `expires_at`;
- соответствие ожидаемому Threads-профилю;
- согласованность debugger application identity между grant этого приложения.

Token, App Secret, app id и user id нельзя выводить в терминальный лог, issue или
чат. Поле `app_id`, возвращаемое Threads Debugger, не обязано совпадать с
публичным Threads App ID из use-case settings; его нельзя использовать для
прямого сравнения этих двух identifier surfaces. После успешного owner-only
OAuth debugger запускается повторно уже для сохранённого зашифрованного token;
только затем разрешается отдельная первая публикация.

Источник требования — сама Meta: официальная
[Threads API collection в workspace Meta](https://www.postman.com/meta/threads/folder/34203612-e0373e84-de6b-46f1-b90d-3fea76ba6782).

## 5. Uninstall и Data Deletion callbacks

Официальная настройка Threads use case требует ещё два отдельных публичных
HTTPS endpoint:

```text
https://news.questtales.com/api/oauth/threads/uninstall
https://news.questtales.com/api/oauth/threads/delete
```

Их нельзя заменять OAuth redirect URL: Meta отправляет на оба адреса
form-encoded `POST` с полем `signed_request`. Pipeline проверяет
HMAC-SHA256-подпись через `THREADS_APP_SECRET`.

Секрет нельзя передавать в чат или лог. Пока он не задан, прямой `GET` обоих
адресов подтверждает доступность для настройки Meta, но любой `POST` закрыто
отклоняется с `503`.

Uninstall callback подтверждает валидное отключение приложения. Data Deletion
callback возвращает требуемые Meta `url` и `confirmation_code`; статусная
страница сообщает, что pipeline не сохраняет Threads-профиль, посты или
пользовательский контент.

## 6. Что именно публикует pipeline

Для source post создаётся отдельный text-only Threads post:

- текст до 500 Unicode code points передаётся без переписывания;
- текст от 501 code points делится на непрерывные части без повторов: основной
  post содержит первый исходный фрагмент, а native article начинается с первого
  ещё не прочитанного символа. Граница основного post выбирается по последнему
  подходящему абзацу или предложению, затем по границе слова; жёсткий срез
  используется только когда естественной границы нет;
- разделительный whitespace публикуется внутри уже прочитанного root-префикса,
  перед CTA, поэтому native article начинается непосредственно с содержимого,
  а не с повторения начала или пустых строк;
- валидный исходный Facebook permalink передаётся как
  `text_attachment.link_attachment_url` только когда весь непрочитанный остаток
  помещается в native article. Meta отвергает максимальный UTF-8 article
  payload с этой дополнительной ссылкой;
- если непрочитанный остаток не помещается в безопасный native article limit
  (10 000 code points и 9 000 UTF-8 bytes), article содержит его первый
  безопасный фрагмент, а каждый следующий code point попадает в
  детерминированную цепочку ответов не длиннее 500 code points. В главном post
  явно указано, что продолжение есть и в статье, и в ответах;
- builder-тесты проверяют инвариант
  `published root source prefix + native article + replies = canonical trimmed source`,
  поэтому
  начало не должно дублироваться и ни один исходный фрагмент не должен
  пропадать;
- ни исходные картинки, ни Instagram custom visual в этот канал не подмешиваются.

Threads adapter принимает отдельный `text_attachment`:

- основной `text` остаётся в пределах 500 code points;
- `text_attachment.plaintext` ограничен 10 000 code points и 9 000 UTF-8
  bytes; второй лимит закреплён после production-проверки Meta на кириллическом
  payload, чтобы не начинать необратимый publish flow с заведомо отклоняемым
  container request;
- опциональный `linkAttachmentUrl` сериализуется как
  `link_attachment_url` только для article до максимального native limit;
- attachment передаётся как JSON в том же container request и использует тот же
  exactly-once publish flow.

Перед необратимым `threads_publish` сервис сохраняет pending-маркер. После
сетевой или Meta-ошибки он не повторяет POST вслепую: `PUBLISHED` остаётся
fail-closed, а только read-only статус `FINISHED` доказывает, что публикации не
было и разрешает следующую ровно одну попытку. Параметр `creation_id` в этом
POST передаётся в query string, как в официальном контракте Meta.

После создания каждого root/reply container pipeline сначала читает его статус
и ждёт `FINISHED` с bounded backoff (1, 2, 4, 8, 8 seconds). Это необходимо
для больших native article: ранний `threads_publish` Meta отклоняет HTTP 400,
хотя container ещё только обрабатывается. Пока `FINISHED` не подтверждён,
publish intent не создаётся и пост остаётся `partial`; никакой второй публичный
write не выполняется. Для нового container после первого `FINISHED` есть ещё
один 8-second settle window перед единственной publish-попыткой; уже pending
receipt не ждёт вслепую, а сначала проходит обычную reconciliation-проверку.

В панели «Рассылка FB» это кнопка `🧵 Threads`; API-эквивалент:

```text
POST /api/source-posts/<source-post-id>/distribute/threads
```

Маршрут защищён тем же операторским доступом, что и остальные способы рассылки.

## 7. Не создавать дубликаты

Meta требует два вызова: сначала `/{threads-user-id}/threads` создаёт
неопубликованный `TEXT` container, затем `/{threads-user-id}/threads_publish`
публикует его. Pipeline сохраняет `threads_container_id` после первого шага и
ставит `threads_publish_pending=1` **до** второго.

Для каждого reply после native article действует тот же инвариант отдельно:
`threads_continuation_container_ids` сохраняет container до publish,
`threads_continuation_pending_index` пишется до необратимого вызова, а
`threads_continuation_ids` — только после подтверждённого reply ID. Следующий
фрагмент отвечает на предыдущий подтверждённый reply, поэтому порядок чтения не
зависит от сортировки sibling replies в клиенте.

Если второй запрос вернул timeout или неясную ошибку, post остаётся `partial`.
При повторном клике pipeline сначала читает Meta container state: `PUBLISHED` и
неизвестный статус не допускают второй `threads_publish`. Только `FINISHED`
доказывает, что Meta ещё не публиковала container, и разрешает одну следующую
попытку. Не удаляйте receipt-поля как способ «попробовать ещё раз».

Ошибка до получения `threads_container_id` безопасна для повторной попытки: не
существует подтверждённого публичного Threads post.

Ошибка до получения container для нового reply также безопасна. Ошибка после
получения container или во время его publish оставляет source post `partial`:
повторный запуск сначала читает container. Только `FINISHED` разрешает одну
следующую попытку; `PUBLISHED`, неизвестный ответ и ошибка чтения не создают
дубликат.

## 8. Обязательная проверка опубликованного результата

После того как получены root ID и все reply ID, pipeline делает только GET-запросы
к каждому exact Threads ID. Он проверяет `TEXT_POST`, native article и текст
каждого продолжения; успешная проверка сохраняется в
`threads_publication_verified_at` и sanitised receipt
`threads_publication_verification_meta`. Пока такого receipt нет, канал
остаётся `partial`.

Если read-back временно недоступен или текст отличается, pipeline не удаляет
ID и не выполняет новый `threads_publish`. Следующий запуск повторяет только
эту проверку. Разбиение текста выбирает границы без ведущего/замыкающего
whitespace: Threads нормализует такие whitespace на самостоятельном reply и
иначе мог бы незаметно склеить слова. Если для редкого pathological input нет
lossless границы в 500 code points, подготовка завершается fail-closed до
создания container.

Один узкий provider-эквивалент допускается только для reply: Graph может
вернуть auto-linked `https://…` без ровно одного обычного пробела прямо перед
URL, а standalone `#` в начале абзаца — как markdown heading delimiter без
самого `#`. Проверка нормализует только эти provider-проекции; native article
по-прежнему сверяется byte-for-byte, а любое иное отличие остаётся `partial`.
