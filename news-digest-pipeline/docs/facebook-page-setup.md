# Facebook Page API — Быстрая настройка публикации

> Краткий справочник по настройке публикации на Facebook **Страницу** (Page) через Graph API.
> Полная история исследования (включая попытки автоматизации профиля) — в `facebook-setup.md`.

---

## 1. Создание приложения Meta

1. Перейти на [developers.facebook.com](https://developers.facebook.com/) → **Create App**
2. Use case: **Content management** → "Manage everything on your Page"
3. Указать имя приложения, email

**ВАЖНО про Business Portfolio:**
- Если при создании привязать приложение к Business Portfolio, то в Graph API Explorer будут видны **только страницы из этого портфолио**
- Если нужны личные страницы (не входящие в портфолио) — выбрать **"I don't want to connect a business portfolio yet"**
- Это можно изменить позже, но проще сразу выбрать правильно

---

## 2. Получение Page Access Token

### Способ A: Graph API Explorer (простой)

1. Перейти в **Tools → Graph API Explorer**
2. Выбрать своё приложение
3. Нажать **"Get Token"** → **"Get Page Access Token"**
4. Выдать permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
5. Выбрать нужную страницу
6. Explorer покажет Page Access Token

### Способ B: Прямой OAuth URL (если Explorer не показывает нужную страницу)

Бывает, что Graph API Explorer не отображает нужную страницу (особенно если она не в Business Portfolio). В этом случае — прямой OAuth:

```
https://www.facebook.com/v23.0/dialog/oauth?client_id=APP_ID&redirect_uri=https://localhost/&scope=pages_manage_posts,pages_read_engagement,pages_show_list&response_type=token
```

Заменить `APP_ID` на ID приложения. После авторизации браузер редиректит на `https://localhost/#access_token=...` — скопировать User Token из URL.

### Получение Page Token из User Token

User Token != Page Token. Нужно обменять:

```bash
curl "https://graph.facebook.com/v23.0/me/accounts?access_token=USER_TOKEN"
```

Ответ содержит список страниц с `access_token` и `id` для каждой:

```json
{
  "data": [
    {
      "access_token": "PAGE_ACCESS_TOKEN_HERE",
      "id": "883174691695126",
      "name": "Alex Krol"
    }
  ]
}
```

### Page ID

| Страница | Page ID |
|----------|---------|
| Alex Krol | `883174691695126` |
| Квест Теории Каст и Ролей (тестовая) | `100686548606025` |

---

## 3. Публикация через API

```bash
curl -X POST "https://graph.facebook.com/v19.0/{PAGE_ID}/feed" \
  -d "message=Текст поста" \
  -d "access_token=PAGE_ACCESS_TOKEN"
```

Ответ:

```json
{
  "id": "883174691695126_123456789"
}

```

---

## 4. Время жизни токена

| Тип | Срок жизни |
|-----|-----------|
| Short-lived token | ~1-2 часа |
| Long-lived token | ~60 дней |

### Обмен short-lived → long-lived

```bash
curl "https://graph.facebook.com/v23.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=APP_ID&\
client_secret=APP_SECRET&\
fb_exchange_token=SHORT_LIVED_TOKEN"
```

**ВАЖНО:** Long-lived токен живёт ~60 дней. Нужно обновлять до истечения срока, иначе публикация перестанет работать.

---

## 5. Переменные окружения

В `.env` файле (или на VPS):

```env
FACEBOOK_PAGE_ID=883174691695126
FACEBOOK_PAGE_ACCESS_TOKEN=EAAxxxxxx...
```

- `FACEBOOK_PAGE_ID` — ID страницы (не профиля!)
- `FACEBOOK_PAGE_ACCESS_TOKEN` — именно Page Access Token, **не** User Token

---

## 6. Проверка

### Проверить, что токен валиден и принадлежит странице

```bash
curl "https://graph.facebook.com/v23.0/me?fields=id,name&access_token=TOKEN"
```

Должен вернуть имя **страницы** (например, "Alex Krol"), а не имя пользователя.

### Проверить доступ к ленте страницы

```bash
curl "https://graph.facebook.com/v23.0/PAGE_ID/feed?access_token=TOKEN"
```

Должен вернуть список последних постов на странице.
