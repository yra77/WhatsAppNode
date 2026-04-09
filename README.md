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
   - retry запускається навіть якщо `lineId` тимчасово відсутній (щоб QR не "зависав" без повторного старту).
3. Додано централізований планувальник retry (`scheduleSessionRetry`) з прозорими логами причини повторної спроби.
4. README синхронізовано з поточним кодом, застарілі формулювання прибрано.

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

За вашими логами від **09.04.2026 20:15:58–20:16:02** сервіс стартує створення сесії для `+380632910991`, отримує `connection close` з кодом `405`, очищає auth-state і видаляє локальну директорію сесії.

Це зазвичай означає пошкоджений або несумісний локальний auth-state для цього номера.

Що робить сервер тепер:
1. ловить `405`;
2. видаляє локальну сесію (`auth_sessions/session-...`);
3. автоматично запускає нову реєстрацію (нова QR-авторизація).

Що зробити вам покроково:
1. Викликати `DELETE /sessiondelete/:phone` для номера, який не реєструється.
2. Перезапустити Node-процес (щоб скинути in-memory стани `clients`/`qrTimers`).
3. Викликати `POST /registerwhatsapp` з обома полями:
   ```json
   {
     "phone": "+380632910991",
     "lineId": "your-line-id-from-crm"
   }
   ```
4. Просканувати новий QR у WhatsApp на телефоні.
5. Перевірити `GET /whatsapp_health` (очікується `status: 1`).

> Важливо: якщо `lineId` у CRM тимчасово не передався, сервер все одно спробує повторно підняти сесію після `405`, щоб не втрачати генерацію QR.

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
