# WhatsAppNode

Сервер інтеграції WhatsApp (Baileys) з CRM (ASP.NET webhook).

## Що виправлено (оновлено 2026-04-01)

### Проблема
Відправка повідомлень перестала працювати, бо JID отримувача формувався як `@lid` для всіх номерів.
Для звичайних номерів WhatsApp очікує `@s.whatsapp.net`, тому повідомлення могли не доставлятися.

### Внесені зміни
- Додано допоміжний метод `resolveRecipientJid(sock, to)`:
  - нормалізує номер телефону;
  - виконує `sock.onWhatsApp(...)` для перевірки існування номера;
  - повертає валідний JID;
  - має fallback на `${number}@s.whatsapp.net`.
- В endpoint `/sendmsg` прибрано жорстко зашитий `@lid`, тепер використовується динамічне визначення JID.
- Додані пояснювальні коментарі в змінені ділянки коду.

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
Повертає health-статуси активних сесій.

## Налаштування

Створіть `.env`:

```env
PORT=3000
BASE_URL=http://localhost:5000
LOG_DIR=Logs
```

## Запуск

```bash
npm install
node index.js
```

## Що ще треба зробити у проєкті

1. Додати endpoint для повторної синхронізації конкретної сесії без перезапуску процесу.
2. Додати валідацію вхідних payload (наприклад, через `zod` або `joi`) для `/registerwhatsapp` і `/sendmsg`.
3. Додати автотести:
   - юніт-тести для `resolveRecipientJid`;
   - інтеграційні тести API endpoint-ів через `supertest`.
4. Додати обмеження частоти запитів (rate limit) на endpoint-и API.
5. Додати structured-логування і кореляційний `requestId` між Node та CRM.
6. Додати скрипт health-monitoring, який перевіряє reconnect завислих сесій.
7. Описати process manager (pm2/systemd) та стратегiю автоперезапуску в production.

## Примітка
Якщо після оновлення номер уже мав стару/биту авторизацію, видаліть сесію через `/sessiondelete/:phone` і пройдіть QR-авторизацію повторно.
