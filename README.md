# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (Baileys) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-09)

### Внесені зміни

1. **Виправлено сценарій з `connection.close` кодом `405`, коли QR не повертався у фронт**:
   - додано `pendingRegisterResponses` для збереження активної HTTP-відповіді `/registerwhatsapp`;
   - при повторному підключенні (retry після `405`) QR або `success` тепер відправляються у той самий запит, якщо він ще відкритий;
   - додано централізований helper `respondToPendingRegister(...)`, який безпечно відповідає клієнту та очищує pending-стан.
2. **Покращено cleanup сесії**:
   - під час `safelyDestroySession(...)` очищується pending-відповідь реєстрації для номера, щоб уникнути "висячих" response-обʼєктів.
3. **Актуалізовано документацію**:
   - прибрано неактуальні пояснення;
   - додано окремий блок діагностики для помилки `405` і відсутності QR.

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

Відповіді:
- `{"status":"qr","qr":"data:image/png;base64,..."}` — згенеровано QR;
- `{"status":"success"}` — сесія підключена;
- `{"status":"error","message":"..."}` — помилка.

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
Повертає health-статуси активних сесій:
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

## Помилка `405` і чому QR міг не зʼявлятись

### Що означає `405` у цьому проєкті

У поточній інтеграції `connection.close` з кодом `405` зазвичай означає, що локальний `auth-state` невалідний/пошкоджений або сесія на стороні WhatsApp стала несумісною і потрібна нова QR-авторизація.

### Чому раніше QR не доходив до UI

Після `405` сервер очищав `auth_sessions` і запускав retry, але QR з retry-спроби інколи не повертався в первинний HTTP-запит `/registerwhatsapp`, через що у UI виглядало як "реєстрація зависла без QR".

### Що тепер змінено

QR/`success` можуть бути повернуті клієнту навіть якщо вони зʼявились вже після retry (поки HTTP-запит ще активний).

### Практичний чекліст

1. Виклич `DELETE /sessiondelete/:phone` для проблемного номера.
2. Перезапусти Node-процес.
3. Повтори `POST /registerwhatsapp` з `phone` і `lineId`.
4. Проскануй новий QR.
5. Перевір `GET /whatsapp_health` — очікується `status: 1`.

---

## Що ще треба зробити у проєкті

1. Додати валідацію payload (`zod` або `joi`) для `/registerwhatsapp` і `/sendmsg`.
2. Додати автотести:
   - юніт-тести для `resolveRecipientJid`, `setSessionHealthy`, `setSessionHasUser`;
   - інтеграційні тести endpoint-ів (`supertest`).
3. Додати `rate limit` на API endpoint-и.
4. Додати structured-логування та `requestId` для кореляції між Node і CRM.
5. Додати endpoint ручної ресинхронізації сесії (без рестарту процесу).
6. Додати production-runbook (`pm2/systemd`, автостарт, ротація логів).
7. Додати базову авторизацію/секрет для API.
8. Додати метрики (`/metrics` Prometheus) для спостереження за retry, 405, reconnect, send failures.
