# WhatsAppNode

Сервер інтеграції WhatsApp (Baileys) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-09)

### Що змінено

1. Стабілізовано обробку `connection.close` у Baileys:
   - додано логування **коду + причини** від'єднання;
   - для тимчасових кодів (`restartRequired`, `connectionClosed`) залишено авто-reconnect;
   - для `401 (loggedOut)` — очищення сесії та повідомлення CRM.
2. Додано окрему обробку для `код 405`:
   - примусове очищення локального `auth-state`;
   - автоматичний повторний старт реєстрації через 5 секунд;
   - коментарі в коді з поясненням причини (щоб уникнути циклу `close -> 405 -> close`).
3. README оновлено відповідно до фактичної поведінки сервера, застарілі пункти прибрано.

---

## API

### `POST /registerwhatsapp`
Реєстрація/ініціалізація WhatsApp-сесії.

Body:
```json
{
  "phone": "+380XXXXXXXXX",
  "lineId": "crm-line-id"
}
```

### `POST /sendmsg`
Відправка повідомлення в WhatsApp.

Body:
```json
{
  "from": "+380XXXXXXXXX",
  "to": "+380YYYYYYYYY",
  "message": "Текст повідомлення",
  "contentType": "text"
}
```

Підтримувані `contentType`:
- `text`
- `image` (за наявності `filePath`)
- `document` (за наявності `filePath`)

### `DELETE /sessiondelete/:phone`
Видаляє сесію номера.

### `GET /whatsapp_health`
Повертає health-статуси активних сесій у форматі:
```json
[
  {
    "phone": "+380XXXXXXXXX",
    "status": 1
  }
]
```
де `status: 1` — сесія активна, `status: 0` — неактивна/неавторизована.

---

## Налаштування

Створіть `.env`:

```env
PORT=3000
BASE_URL=http://localhost:5000
LOG_DIR=Logs
```

---

## Запуск

```bash
npm install
node index.js
```

---

## Чому у вас може бути `Код: 405` при реєстрації

За вашими логами (`2026-04-09 19:59:29` — `20:01:44`) сервіс кілька разів стартує створення сесії і одразу отримує `connection close` з кодом `405`.

Це зазвичай означає пошкоджений або несумісний локальний auth-state для цього номера.

Що робить сервер тепер:
1. ловить `405`;
2. видаляє локальну сесію (`auth_sessions/session-...`);
3. автоматично запускає нову реєстрацію (нова QR-авторизація).

Що зробити вам:
1. Запустити `DELETE /sessiondelete/:phone` для номера.
2. Викликати `POST /registerwhatsapp`.
3. Просканувати новий QR у WhatsApp на телефоні.
4. Перевірити `GET /whatsapp_health` (очікується `status: 1`).

---

## Що ще треба зробити у проєкті

1. Додати валідацію вхідних payload (`zod`/`joi`) для `/registerwhatsapp` і `/sendmsg`.
2. Додати автотести:
   - юніт-тести для `resolveRecipientJid`, `setSessionHealthy`, `setSessionHasUser`;
   - інтеграційні тести endpoint-ів через `supertest`.
3. Додати rate limit на API endpoint-и.
4. Додати structured-логування та кореляційний `requestId` між Node та CRM.
5. Додати endpoint для ручної ресинхронізації конкретної сесії без перезапуску процесу.
6. Додати production-документацію запуску (`pm2/systemd`, автоперезапуск, ротація логів).
7. Додати базову авторизацію/секрет для API endpoint-ів.
