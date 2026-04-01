# WhatsAppNode

Сервер інтеграції WhatsApp (Baileys) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-01)

### Що виправлено

1. Виправлено формування JID отримувача у `/sendmsg`:
   - додано `resolveRecipientJid(sock, to)`;
   - прибрано жорстко зашитий `@lid`;
   - додано fallback на `${number}@s.whatsapp.net`.

2. Виправлено перевірку стану сесій у `/whatsapp_health`:
   - виправлено логіку збереження `hasUser`, щоб статус не "падав" під час reconnect;
   - додано окремий helper `setSessionHasUser(phone, hasUser)`;
   - додано оновлення `hasUser` у `creds.update`;
   - health-check тепер враховує як `sessionStatus.hasUser`, так і `sock.user`.

3. Додано пояснювальні коментарі у змінених методах для підтримки.

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

## Що ще треба зробити у проєкті

1. Додати валідацію вхідних payload (`zod`/`joi`) для `/registerwhatsapp` і `/sendmsg`.
2. Додати автотести:
   - юніт-тести для `resolveRecipientJid`, `setSessionHealthy`, `setSessionHasUser`;
   - інтеграційні тести endpoint-ів через `supertest`.
3. Додати endpoint для ручної ресинхронізації конкретної сесії без перезапуску процесу.
4. Додати rate limit на API endpoint-и.
5. Додати structured-логування та кореляційний `requestId` між Node та CRM.
6. Додати health-monitoring для виявлення "завислих" reconnect-сесій.
7. Додати документацію для production-запуску (pm2/systemd + стратегія автоперезапуску).
8. Додати базову авторизацію/секрет для API endpoint-ів, щоб обмежити несанкціонований доступ.

---

## Примітка

Якщо після оновлень номер має стару/пошкоджену авторизацію:
1. Видаліть сесію через `/sessiondelete/:phone`.
2. Перезапустіть авторизацію через `/registerwhatsapp`.
3. Проскануйте QR повторно.
