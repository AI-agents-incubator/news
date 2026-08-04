# Telegram в News: приём ссылок и публикация

News использует Telegram только как редакционный канал:

- принимает URL от владельца через webhook;
- публикует готовые дайджесты и source-posts в канал.

Moderator, Assistant и Gatekeeper являются отдельным продуктом
[AIchatTG](https://github.com/alexeykrol/AIchatTG) со своими webhook, токенами,
базой данных, моделями и операторским интерфейсом. Их нельзя настраивать через
News или подключать к базе News.

## Бот и переменные окружения

Создайте бота через [@BotFather](https://t.me/BotFather) и задайте:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_PUBLISH_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
BASE_URL=https://YOUR_DOMAIN
```

- `TELEGRAM_CHAT_ID` — личный чат владельца, откуда разрешён приём URL.
- `TELEGRAM_PUBLISH_CHAT_ID` — целевой канал; если не задан, используется
  `TELEGRAM_CHAT_ID`.
- `TELEGRAM_WEBHOOK_SECRET` — секрет заголовка Telegram webhook. Без него
  endpoint работает fail-closed и отвечает 403.

## Webhook для редакционных URL

Адрес:

```text
https://YOUR_DOMAIN/api/telegram/webhook
```

При запуске News регистрирует этот URL через `setWebhook`, если задан
`BASE_URL`. Telegram передаёт секрет в заголовке
`X-Telegram-Bot-Api-Secret-Token`; News сравнивает его с
`TELEGRAM_WEBHOOK_SECRET`.

Бот принимает сообщения только из `TELEGRAM_CHAT_ID`, извлекает URL, сохраняет
уникальные статьи с источником `telegram` и сообщает число новых материалов и
дубликатов. URL-only записи сначала проходят извлечение текста; пустые записи не
запускают генерацию.

Команды редакционного бота:

| Команда | Назначение |
|---|---|
| `/start`, `/help` | Краткая справка |
| `/status` | Статусы статей и число готовых материалов |
| `/generate` | Запуск фазы обработки готовых статей |

## Публикация в канал

Добавьте бота администратором канала с правом **Post Messages**. Для channel ID
используйте полное значение с префиксом `-100`.

News разбивает длинный текст на сообщения, сохраняет delivery receipt и не
повторяет неопределённую отправку вслепую. Подвал, приглашающий читателя к
AIchatTG Assistant через `/ask`, остаётся частью редакционного шаблона
публикации News; сам Assistant в этом репозитории не запускается.

## Проверка

1. Запустите приложение с заполненными переменными.
2. Проверьте `getWebhookInfo` для редакционного бота: URL должен оканчиваться на
   `/api/telegram/webhook`.
3. Отправьте URL из разрешённого личного чата и убедитесь, что статья появилась
   в News.
4. Проверку реальной публикации выполняйте только с отдельным разрешением:
   она создаёт внешнее сообщение.

## Устранение неполадок

- `403` на webhook: отсутствует или не совпадает `TELEGRAM_WEBHOOK_SECRET`.
- `chat not found`: проверьте полный channel ID и права бота.
- `409 Conflict: terminated by other getUpdates request`: для одного токена
  одновременно запущены polling и webhook; оставьте один delivery-механизм.
- URL принят, но дайджест не строится: проверьте, что сервер извлёк непустой
  текст достаточной длины.

Не добавляйте сюда Telegram-AI переменные `MODERATION_TELEGRAM_*`,
`ASSISTANT_*` или `GUARD_*` — они принадлежат AIchatTG. Facebook-модерация
News Pro по-прежнему использует свои `MODERATION_*` ключи.
