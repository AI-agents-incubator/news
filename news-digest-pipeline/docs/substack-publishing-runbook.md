# Substack publisher: безопасный runbook для `biggame`

**Область:** выделенный внутренний publisher и приватная тестовая публикация
`biggame`. Этот документ не разрешает публикацию в другие издания, отправку
email, production deployment или передачу секретов.

## Инварианты

- News обращается только к настроенному внутреннему publisher по Bearer token.
  Token остаётся на сервере и не попадает в UI, receipt или текст ошибки.
- `substackPublicationUrl` — HTTPS URL ровно одной публикации. В нём допустимы
  только host и path: credentials, query string, fragment и подмена origin
  отклоняются до сетевого запроса.
- Publisher принимает медиа только по абсолютным путям внутри
  `/app/data/source-post-images`. Порядок массива является порядком вложений.
  Разрешены только перечисленные adapter-ом MIME для image/video/audio.
- Режимы только `draft_only` и `web_only`. Email, audience, recipients,
  schedule и любые send-переключатели от вызывающего кода запрещены.
- Создание всегда отправляет `mode: "draft_only"`. Даже при конфигурации
  `web_only` публикация остаётся отдельной операцией.
- Web-публикация всегда отправляет `mode: "web_only"` и `send: false`.
  В adapter-е нет email/send API.

## Состояния и idempotency

До каждого POST вызывающая сторона сохраняет новый стабильный `attemptId`.
Один logical attempt всегда повторно использует тот же id; новый id нельзя
создавать как способ обойти неопределённый результат.

| Состояние | Доказательство | Разрешённое следующее действие |
| --- | --- | --- |
| `auth_required` | Publisher вернул машинный код | Один раз войти владельцем через защищённый noVNC; не повторять POST до проверки сессии |
| `draft_request_pending` | `attemptId` сохранён до POST `/drafts` | Выполнить ровно один POST |
| `draft_outcome_unknown` | Timeout/обрыв до HTTP response | Не повторять POST; reconcile по тому же `attemptId` |
| `draft` | Sanitized receipt содержит `draftId`, `attemptId`, state `draft` | Сохранить `draftId`, затем GET verification |
| `draft_verified` | GET совпал по publication, title, subtitle, body и ordered media | Оставить для ручной проверки; web publish требует отдельного разрешения |
| `publish_request_pending` | Publish `attemptId` сохранён до POST | Выполнить ровно один POST `/drafts/:id/publish` |
| `publish_outcome_unknown` | Timeout, обрыв или неоднозначный receipt | Не повторять POST; read-only reconcile по draft/attempt |
| `published` | Receipt подтверждает configured publication, `web_only`, `send:false` | Проверить exact permalink read-only и сохранить verification |

HTTP error с полученным ответом — известный отказ. Обрыв/timeout любого POST
имеет `outcomeUnknown=true`; вызывающая сторона обязана заблокировать blind
retry. Adapter сам запросы не повторяет.

## Первый запуск: только draft

1. Оставить `substackMode=draft_only`.
2. Убедиться, что URL указывает ровно на приватную тестовую публикацию
   `biggame`, а publisher token задан только в server-side secret storage.
3. Создать явно помеченный test draft с новым сохранённым `attemptId`.
4. Сохранить `draftId` из receipt.
5. Выполнить `GET /drafts/:id` и потребовать точного совпадения publication,
   title, subtitle, `bodyText` и ordered media.
6. Вручную открыть draft в `biggame` и проверить текст, порядок/тип медиа и
   отсутствие audience/email delivery.
7. Остановиться. Успешный draft не является разрешением на web publication.

## Одноразовая авторизация через noVNC

`auth_required` означает отсутствие/истечение browser session, а не ошибку,
которую можно исправлять автоматическими POST retry.

1. Остановить write-операцию и сохранить текущие `attemptId`/`draftId`.
2. Открыть noVNC только через утверждённый закрытый канал доступа. Не публиковать
   noVNC в Internet и не помещать URL/пароль/cookie в логи или чат.
3. Войти owner-аккаунтом Substack и подтвердить, что активна именно приватная
   `biggame`.
4. Закрыть noVNC и проверить status внутреннего publisher без публикации.
5. Повторять только известный отказ. Если исходный POST был ambiguous,
   сначала reconcile по прежнему `attemptId`.

Browser profile/cookies хранятся только в выделенном persistent volume
publisher-а. Их нельзя копировать в News, SQLite receipts или артефакты теста.

## Gate для web-only публикации

Переход `draft_only` → `web_only` — kill-switch capability, но не
пользовательское разрешение. До POST должны одновременно существовать:

- точное разрешение владельца на web-only публикацию конкретного test draft;
- подтверждение, что target — приватная `biggame`;
- сохранённые `draftId`, draft verification и новый publish `attemptId`;
- визуальная проверка draft;
- подтверждение, что email/audience/schedule отсутствуют.

Только после этого временно включается `web_only` и выполняется один POST с
`send:false`. Разрешение на web-only не разрешает email, другую публикацию,
обычный production content, deploy или изменение доступа.

## Kill switches

В порядке от обычного к аварийному:

1. Вернуть `substackMode=draft_only`: новые publish-запросы будут отклонены до
   сети, drafts останутся доступны.
2. Убрать publisher token из News runtime: все операции fail-closed.
3. Остановить внутренний publisher: никакой browser write невозможен.
4. Отозвать browser session/cookies в выделенном publisher volume при
   подозрении на компрометацию.

После kill switch нельзя удалять receipt или менять `attemptId`, чтобы
«попробовать заново».

## Восстановление

- **`auth_required`:** выполнить одноразовый owner login, затем status/read
  check. Не пересоздавать draft.
- **Create timeout/обрыв:** искать draft по сохранённому `attemptId`. Если
  найден один exact draft, сохранить его `draftId` и выполнить verification.
  Если найдено ноль или больше одного — остановиться для ручного разбора.
- **Verification mismatch:** ничего не публиковать и не создавать заново.
  Сохранить sanitized mismatch field; исправление требует нового осознанного
  draft attempt.
- **Publish timeout/обрыв:** проверить draft state и exact permalink по тому же
  publish `attemptId`. Найденная web publication блокирует повторный POST.
  Не доказанное отсутствие публикации также блокирует повторный POST.
- **Неверный target/permalink или признак email:** включить kill switches,
  сохранить sanitized evidence и остановиться. Удаление/редактирование
  внешнего поста — отдельное destructive production действие и требует нового
  явного разрешения.

Никакая локальная проверка adapter-а сама по себе не доказывает состояние
Substack и не разрешает внешний вызов. На приватной `biggame` уже подтверждены
owner login через закрытый noVNC, реальные draft-only записи, точный read-back,
изображения и native audio/video. Web-only publication остаётся неисполненным
отдельным operational gate и требует нового точного разрешения владельца.
