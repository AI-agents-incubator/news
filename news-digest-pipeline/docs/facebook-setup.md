# Facebook Publishing: полный гайд по настройке

Документ описывает весь путь настройки публикации дайджестов в Facebook — от создания приложения Meta до автоматизации через браузер. Два независимых канала: **Facebook Page** (Graph API) и **личный профиль** (Patchright).

---

## 1. Facebook Graph API (публикация на Page)

### 1.1. Создание Meta Developer App

1. Перейти на [developers.facebook.com](https://developers.facebook.com/)
2. **Create App** → выбрать тип **Content management** (среди прочих "Other", "Business" — именно Content management)
3. В описании приложения: "Manage everything on your Page"
4. Указать имя приложения и контактный email

#### Подводный камень: Business Portfolio

При создании приложения Meta предлагает привязать его к Business Portfolio. Это критический момент:

- Приложение привязывается к конкретному Business Portfolio (например, BM#1)
- Если нужная Page привязана к **другому** Business Portfolio или не привязана ни к какому — она **не будет видна** при генерации токена в Graph API Explorer
- Позже это проявляется как "страница не появляется в списке" при попытке получить Page Access Token

**Рекомендация:** убедиться, что приложение и целевая Page привязаны к одному и тому же Business Portfolio, либо использовать прямой OAuth URL (описано ниже).

### 1.2. Получение Page Access Token

#### Способ 1: Graph API Explorer (стандартный, но с проблемами)

1. Открыть [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Выбрать созданное приложение в верхнем дропдауне
3. Добавить разрешения (permissions):
   - `pages_manage_posts` — публикация постов
   - `pages_read_engagement` — чтение вовлечённости
   - `pages_show_list` — показ списка страниц
4. Нажать **Generate Access Token**
5. Авторизоваться через Facebook → выбрать страницы, к которым даётся доступ
6. В дропдауне "Page or User Token" выбрать нужную страницу

**Проблема, с которой столкнулись:** страница "Alex Krol" не появлялась в дропдауне. Причина — страница была привязана к Business Portfolio, но приложение не было добавлено как Connected Asset этого портфолио.

**Попытка решения через Business Settings:**
- Business Settings → Pages → выбрать страницу → Connected Assets → добавить приложение
- **Не сработало** — приложение всё равно не видело страницу

#### Способ 2: Прямой OAuth URL (рабочий вариант)

Вместо Graph API Explorer использовать прямой OAuth-запрос в браузере:

```
https://www.facebook.com/v23.0/dialog/oauth?client_id=APP_ID&redirect_uri=https://localhost/&scope=pages_manage_posts,pages_read_engagement,pages_show_list&response_type=token
```

Заменить `APP_ID` на ID приложения (виден в Dashboard приложения на developers.facebook.com).

После авторизации браузер перенаправит на:
```
https://localhost/#access_token=EAAG...&...
```

Скопировать `access_token` из URL — это **User Access Token** (короткоживущий, ~1 час).

Далее получить Page Token через API:

```bash
curl "https://graph.facebook.com/v23.0/me/accounts?access_token=USER_ACCESS_TOKEN"
```

Ответ содержит массив страниц с полями `name`, `id`, `access_token`. Найти нужную страницу и взять её `access_token` — это **Page Access Token**.

### 1.3. Обмен на долгоживущий токен

Токен, полученный выше, живёт ~1 час. Для обмена на долгоживущий (60 дней):

```bash
curl "https://graph.facebook.com/v23.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=APP_ID&\
client_secret=APP_SECRET&\
fb_exchange_token=SHORT_LIVED_TOKEN"
```

`APP_SECRET` находится в настройках приложения: App Dashboard → Settings → Basic → App Secret (нажать Show).

**Важно:** Page Access Token, полученный через `GET /me/accounts` с использованием долгоживущего User Token, сам становится долгоживущим (бессрочным, пока не отозван). Поэтому порядок такой:

1. Получить короткоживущий User Token (OAuth)
2. Обменять на долгоживущий User Token (endpoint выше)
3. Запросить `GET /me/accounts` с долгоживущим User Token
4. Полученный Page Access Token — бессрочный

### 1.4. Публикация через Graph API

```bash
curl -X POST "https://graph.facebook.com/v19.0/PAGE_ID/feed" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Текст поста...",
    "access_token": "PAGE_ACCESS_TOKEN"
  }'
```

Ответ:
```json
{ "id": "PAGE_ID_POST_ID" }
```

URL поста: `https://www.facebook.com/PAGE_ID/posts/POST_ID`

В коде проекта это реализовано в `src/services/publishers/facebook.js` — POST-запрос на `https://graph.facebook.com/v19.0/{pageId}/feed`.

### 1.5. Ограничения

- Graph API работает **только для Pages**, не для личных профилей
- Facebook закрыл API публикации в личный профиль в 2018 году
- Page Access Token дает доступ только к конкретной странице, не ко всем
- Rate limits: ~200 постов/час на страницу (для дайджестов более чем достаточно)

---

## 2. Facebook Personal Profile (публикация через Patchright)

### 2.1. Почему браузерная автоматизация

Facebook закрыл API для публикации в личный профиль в 2018 году. Единственный способ автоматизировать публикацию — эмулировать действия пользователя в браузере.

### 2.2. Почему Patchright, а не Playwright

[Patchright](https://github.com/nicecloudy/patchright) — форк Playwright с патчами для обхода обнаружения автоматизации:

- **Runtime.enable** — стандартный Playwright подключается к браузеру через CDP (Chrome DevTools Protocol) и вызывает `Runtime.enable`, что оставляет обнаруживаемый сигнал. Patchright патчит это поведение.
- **navigator.webdriver** — в стандартном Playwright `navigator.webdriver === true`. Patchright устанавливает `false`.
- **Другие bot-сигналы** — CDP-следы в стеке вызовов, нетипичные значения WebGL, отсутствие плагинов браузера и т.д.

Без этих патчей Facebook с высокой вероятностью определит автоматизацию и может заблокировать аккаунт.

### 2.3. Архитектурное решение: отдельный браузер

Ключевое решение — использовать `launchPersistentContext()` (отдельный Chromium) вместо `connectOverCDP()` (подключение к пользовательскому Chrome):

```javascript
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1200, height: 800 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
});
```

**Преимущества:**
- Пользователь продолжает работать в своём Chrome — нет конфликтов фокуса
- Сессия (cookies, login state) сохраняется в директории `.fb-profile/`
- Нет необходимости запускать Chrome с `--remote-debugging-port`
- Нет проблем с координатами окна и multi-monitor
- При `connectOverCDP` Chrome должен быть полностью закрыт и перезапущен с `--user-data-dir` — непрактично

**Альтернативный подход, который исследовали (connectOverCDP):**

Пробовали подключаться к пользовательскому Chrome через:
```bash
# Chrome должен быть запущен с этими флагами:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

Проблемы:
- `--remote-debugging-port` требует `--user-data-dir` — иначе Chrome игнорирует порт
- Chrome должен быть **полностью закрыт** перед запуском (не просто закрыть окна, а Cmd+Q)
- При автоматизации окно Chrome перехватывает фокус — пользователь не может работать
- Координаты клика требуют учёта toolbar offset (~87px) и позиции на мониторе
- На multi-monitor системах координаты ещё сложнее

### 2.4. Исследование bot-detection

Facebook использует многоуровневую систему обнаружения ботов:

| Сигнал | Описание | Решение |
|--------|----------|---------|
| CDP Runtime.enable | Стандартный Playwright/Puppeteer оставляет следы CDP | Patchright патчит |
| navigator.webdriver | Стандартный автоматизированный браузер = true | Patchright: false |
| Скорость набора | Мгновенный ввод текста нетипичен | `insertText` + паузы |
| Паттерны мыши | Отсутствие движения мыши | Скроллинг ленты |
| Время сессии | Мгновенный пост без "чтения ленты" | Рандомный скроллинг перед постом |
| Clipboard paste | Ctrl+V / Cmd+V в React-editor иначе, чем insertText | Используем insertText |

#### Ввод текста: insertText vs clipboard

Facebook использует React-based WYSIWYG редактор (contenteditable div). Варианты ввода:

- **`page.keyboard.insertText(text)`** — работает корректно. Вставляет весь текст как единое событие `insertText` в InputEvent. React-editor принимает это.
- **Clipboard paste через System Events (osascript)** — не работает в React-editor Facebook. Текст либо не вставляется, либо вставляется частично. Причина: React перехватывает paste-событие и обрабатывает его иначе, чем нативный contenteditable.
- **`page.keyboard.type(text)`** — посимвольный ввод. Работает, но крайне медленно для больших текстов (дайджест может быть 3000+ символов). Не используется.

### 2.5. Технические проблемы и решения

#### Проблема: Facebook hashtag dropdown закрывает кнопку Next

При вводе текста с хэштегами (например, `#новости`, `#AI`) Facebook показывает дропдаун с предложениями. Этот дропдаун может визуально перекрывать кнопку "Next" или "Post".

**Решение:**
```javascript
// Закрыть все дропдауны
await page.keyboard.press('Escape');
await sleep(500);

// Кликнуть на нейтральную область (заголовок диалога)
const dialogTitle = page.locator('text=Create post').first();
if (await dialogTitle.isVisible().catch(() => false)) {
  await dialogTitle.click();
  await sleep(500);
}

// Использовать force click для кнопки Next
await nextBtn.click({ force: true });
```

#### Проблема: двухшаговый flow публикации

На личных профилях Facebook использует двухшаговый диалог:
1. Первый экран: редактор текста + кнопка **Next**
2. Второй экран: настройки аудитории + кнопка **Post**

На Pages — одношаговый (только Post). Скрипт обрабатывает оба варианта:

```javascript
const hasNext = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
if (hasNext) {
  await nextBtn.click({ force: true });
  await sleep(rand(2000, 3000));
  // Затем кликаем Post
  const postBtn = page.locator('[aria-label="Post"]').first();
  await postBtn.click();
} else {
  // Одношаговый — сразу Post
  const postBtn = page.locator('[aria-label="Post"]').first();
  await postBtn.click();
}
```

#### Проблема: link preview snippets

Когда пост содержит URL-ы, Facebook генерирует превью ссылок (Open Graph cards). В дайджесте может быть 15+ ссылок — каждая пытается создать превью. Это:
- Засоряет пост визуально
- Замедляет загрузку
- Может вызвать ошибки публикации

**Решение:** удаление всех превью в цикле:

```javascript
for (let attempt = 0; attempt < 15; attempt++) {
  await sleep(2000);
  const removeBtn = page.locator(
    '[aria-label="Remove link preview from your post"], ' +
    '[aria-label="Удалить превью ссылки из публикации"]'
  ).first();
  const hasPreview = await removeBtn.isVisible({ timeout: 1000 }).catch(() => false);
  if (!hasPreview) break;
  await removeBtn.click();
  await sleep(1500);
}
```

Важно: превью загружаются асинхронно (Facebook делает fetch каждой ссылки), поэтому нужны паузы между проверками.

#### Проблема: локализация UI

Facebook показывает интерфейс на языке пользователя. Aria-labels различаются:
- EN: `Create a post`, `Post`, `Next`, `Remove link preview from your post`
- RU: `Создать публикацию`, `Опубликовать`, `Удалить превью ссылки из публикации`

**Решение:** множественные селекторы через запятую:
```javascript
page.locator('[aria-label="Post"], [aria-label="Опубликовать"]')
```

Также при запуске Patchright устанавливается `locale: 'en-US'`, чтобы минимизировать вариативность, но это не всегда срабатывает (Facebook может использовать язык аккаунта, а не браузера).

### 2.6. Использование скрипта

Скрипт: `scripts/fb-publish.js`

**Первый запуск — логин:**
```bash
cd news-digest-pipeline
node scripts/fb-publish.js --login
```
Откроется браузер Chromium с Facebook. Залогиниться вручную. После успешного входа закрыть браузер — сессия сохранится в `.fb-profile/`.

**Публикация последнего дайджеста:**
```bash
node scripts/fb-publish.js latest
```

**Публикация конкретного дайджеста:**
```bash
node scripts/fb-publish.js <digest-id>
```

Скрипт загружает текст дайджеста с сервера (`https://YOUR_DOMAIN/api/digests/{id}/text`), открывает Facebook в отдельном Chromium, имитирует действия пользователя и публикует пост. Время выполнения: ~30 секунд.

**Данные профиля:** `.fb-profile/` (gitignored). Содержит cookies, localStorage и другие данные сессии Chromium. Если удалить — нужно снова залогиниться через `--login`.

### 2.7. Поведение, имитирующее человека

Скрипт включает рандомизированные задержки и действия:

1. Скроллинг ленты (2-4 раза, случайная дистанция)
2. Возврат наверх с паузой
3. Открытие диалога создания поста
4. Вставка текста + длинная пауза ("чтение/редактирование")
5. Удаление превью ссылок
6. Пауза перед публикацией ("финальный просмотр")
7. Публикация

Все паузы рандомизированы через `rand(min, max)`.

---

## 3. Общая архитектура публикации

### 3.1. Каналы публикации

| Канал | Метод | Скорость | Особенности |
|-------|-------|----------|-------------|
| Telegram | Bot API | Мгновенно | Сплитит сообщения >4096 символов по границам пунктов |
| Facebook Page | Graph API | Мгновенно | Нужен Page Access Token (бессрочный при правильной генерации) |
| Facebook Profile | Patchright (браузер) | ~30 секунд | Нужна залогиненная сессия в `.fb-profile/` |
| YouTube | Не поддерживается | — | API не позволяет создавать Community Posts; только вручную |

### 3.2. Последовательность публикации

1. **Telegram + Facebook Page** — публикуются первыми через API (мгновенно, параллельно)
2. **Пауза 2-5 минут** — чтобы не триггерить spam-detection на Facebook
3. **Facebook Profile** — публикуется через браузерную автоматизацию

### 3.3. Кнопка публикации

На дашборде `YOUR_DOMAIN` есть кнопка "Опубликовать", которая запускает публикацию через API-сервер. Серверная часть вызывает `publishDigest()` из `src/services/publishers/index.js`, который последовательно публикует в Facebook Page и Telegram.

Публикация в личный профиль Facebook запускается отдельно через `scripts/fb-publish.js` (требует доступ к GUI браузера, не работает на headless сервере).

### 3.4. Статусы публикации

После публикации в БД обновляются поля:
- `facebook_post_id` — ID поста на странице
- `telegram_message_id` — ID первого сообщения в канале
- `status` → `published`
- `published_at` — timestamp публикации

---

## 4. Переменные окружения

В файле `.env` (или docker-compose.yml для продакшена):

```env
# --- Telegram ---
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
# Токен бота. Получить через @BotFather в Telegram.

TELEGRAM_PUBLISH_CHAT_ID=-100XXXXXXXXXX
# ID канала для публикации. Формат: -100 + числовой ID канала.
# Узнать ID: добавить бота в канал как администратора,
# отправить сообщение в канал, затем:
#   curl https://api.telegram.org/bot<TOKEN>/getUpdates
# В ответе будет chat.id с префиксом -100.

# --- Facebook Page ---
FACEBOOK_PAGE_ID=123456789012345
# Числовой ID страницы. Виден в ответе GET /me/accounts (поле "id").

FACEBOOK_PAGE_ACCESS_TOKEN=EAAG...
# Page Access Token (не User Token!).
# Должен быть долгоживущий (бессрочный).
# Процедура получения описана в разделе 1.2-1.3 этого документа.
```

### 4.1. Проверка работоспособности токенов

**Telegram:**
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
# Должен вернуть информацию о боте
```

**Facebook Page Token:**
```bash
curl "https://graph.facebook.com/v19.0/me?access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}"
# Должен вернуть name и id страницы
```

**Facebook Token Debug (проверка срока жизни):**
```bash
curl "https://graph.facebook.com/debug_token?\
input_token=${FACEBOOK_PAGE_ACCESS_TOKEN}&\
access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}"
# Поле "expires_at": 0 означает бессрочный токен
```

---

## 5. Troubleshooting

### Page не видна в Graph API Explorer
- Проверить Business Portfolio: приложение и страница должны быть в одном BM
- Использовать прямой OAuth URL (раздел 1.2, способ 2)
- Убедиться, что разрешения `pages_show_list`, `pages_manage_posts` добавлены

### Facebook Page Token истёк
- Повторить процедуру из раздела 1.2-1.3
- Обновить `FACEBOOK_PAGE_ACCESS_TOKEN` в `.env` и перезапустить сервер

### Patchright не логинится / Facebook блокирует
- Удалить `.fb-profile/` и залогиниться заново: `node scripts/fb-publish.js --login`
- Если Facebook требует подтверждение — пройти его вручную в открывшемся Chromium
- Не запускать скрипт слишком часто (>2-3 раза в день подозрительно)

### Текст не вставляется в редактор Facebook
- Проверить, что React-editor доступен: `[role="textbox"][contenteditable="true"]`
- Facebook мог обновить UI — проверить селекторы вручную через DevTools
- Сделать скриншот ошибки: он сохраняется в `/tmp/fb-publish-error.png`

### Кнопка Next/Post не нажимается
- Дропдаун хэштегов может перекрывать кнопку — скрипт отправляет Escape
- Проверить `aria-disabled` — кнопка может быть disabled, если текст не прошёл валидацию
- Используется `{ force: true }` для обхода перекрытия

### Link preview бесконечно загружается
- Скрипт ждёт до 15 итераций (по 2 секунды) для удаления превью
- Если за 30 секунд не удалилось — проблема в сети или Facebook rate limiting
- Можно увеличить количество итераций в скрипте

---

*Последнее обновление: 2026-04-12*
