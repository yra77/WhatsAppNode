# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-10)

### Що змінено

1. **Перехід з Baileys на `whatsapp-web.js` + локальний Chromium**:
   - основна робота сесій тепер побудована через `Client`/`LocalAuth` з `whatsapp-web.js`;
   - використовується локальний браузер з шляху `./chromium/chrome.exe` (якщо файл існує);
   - якщо локального Chromium немає, застосунок використовує браузерний рушій за замовчуванням бібліотеки.

2. **Виправлено критичні помилки ключів сесій**:
   - додано нормалізацію номера (`normalizePhone`) для єдиного ключа в `clients`;
   - виправлено обробники `ready/auth/disconnect`, щоб передавати реальний номер телефону (а не `cleanedClientId`), інакше ламалась логіка notify/reconnect;
   - виправлено `GET /status/:phone` та `DELETE /sessiondelete/:phone` для коректного пошуку активної сесії.

3. **Стабільність і захист від edge-case**:
   - у `unhandledRejection` додано безпечне перетворення `reason` у текст (бо це не завжди `Error`);
   - у коді залишені пояснювальні коментарі в місцях, де були логічні помилки.

4. **Оновлено залежності**:
   - видалено Baileys-орієнтовані/неактуальні залежності;
   - додано `whatsapp-web.js`;
   - `package-lock.json` синхронізовано під актуальний `package.json`.

---

## Вимоги

- Node.js 18+
- npm
- `.env` файл
- Chromium у папці проєкту (рекомендовано):
  - `./chromium/chrome.exe`

> Якщо працюєте не на Windows, потрібно змінити шлях до Chromium у `index.js` під вашу ОС.

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
- `{"status":"qr","qr":"data:image/png;base64,...","phone":"..."}` — згенеровано QR;
- `{"status":"success","phone":"...","lineId":"..."}` — сесія підключена;
- `{"status":"connected"}` — сесія вже існує;
- `{"status":"error","message":"..."}` — помилка.

### `POST /sendmsg`
Відправка повідомлення в WhatsApp.

Body:
```json
{
  "from": "+380XXXXXXXXX",
  "to": "+380YYYYYYYYY",
  "message": "Текст повідомлення",
  "contentType": "text",
  "filePath": "C:/path/to/file.ext",
  "bitrixMessageId": "crm-msg-id"
}
```

Підтримувані `contentType`:
- `text`
- будь-який MIME-тип для медіа/документів, якщо передано `filePath`

### `GET /status/:phone`
Повертає стан сесії для номера (`connected` / `disconnected`).

### `DELETE /sessiondelete/:phone`
Видаляє активну сесію та локальні дані авторизації/кешу.

---

## Що ще треба зробити у проєкті

1. Додати валідацію payload (`zod` або `joi`) для `/registerwhatsapp` і `/sendmsg`.
2. Додати endpoint `GET /whatsapp_health` з узгодженим форматом для CRM-моніторингу.
3. Додати автотести:
   - юніт-тести для утиліт нормалізації номера та побудови шляхів;
   - інтеграційні тести endpoint-ів (`supertest`).
4. Додати `rate limit` та базову авторизацію/секрет для API.
5. Додати structured-логування + `requestId` для кореляції між Node і CRM.
6. Додати runbook для продакшену (`pm2/systemd`, автостарт, ротація логів).
7. Додати метрики (`/metrics` Prometheus) для спостереження за retry/disconnect/send-failures.
