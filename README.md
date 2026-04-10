# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-10)

### Поточне оточення
- Node.js: `v24.11.1`
- Пакування: `pkg@5.8.1`
- Ціль пакування в проєкті: `node18-win-x64`

### Що змінено сьогодні (фікси реєстрації/QR/session cleanup)
1. **Виправлено падіння `res.json is not a function` у `handleQrEvent`:**
   - додано перевірку, що переданий об’єкт є валідною Express-відповіддю (`canReplyJson`);
   - відповідь з QR тепер відправляється тільки для реального HTTP-запиту.
2. **Покращено видалення сесій на Windows (EBUSY/EPERM/ENOTEMPTY):**
   - `removeSessionData` переведено в асинхронний режим;
   - додано retry-механізм з паузами для директорій, які ще тримаються Chromium/puppeteer.
3. **Виправлено timeout QR (30 сек):**
   - при простроченому QR клієнт коректно закривається з `await client.destroy()`;
   - після цього виконується надійне очищення сесії з повторними спробами.
4. **Виправлено повторну реєстрацію після невдалого сканування QR:**
   - у `/registerwhatsapp` перевірка змінена: активною вважається лише сесія в `clients`;
   - якщо знайдена осиротіла папка без активного клієнта — вона очищається автоматично;
   - якщо папка все ще заблокована, API повертає `423 Locked` з поясненням, замість завислого стану.
5. **Уніфіковано безпечну відповідь в HTTP-хендлерах:**
   - `handleReadyEvent` та `handleAuthFailureEvent` теж використовують перевірку `canReplyJson`.

---

## Вимоги
- Windows Server/Windows 10+ для `.exe`
- Node.js 18+
- npm
- `.env` файл
- Chromium у папці проєкту (рекомендовано):
  - `./chromium/chrome.exe`

> Якщо працюєте не на Windows, змініть шлях до Chromium у `index.js`.

---

## Налаштування
Створіть `.env`:

```env
PORT=3000
BASE_URL=http://localhost:5000
LOG_DIR=Logs
# Опційно: URL для отримання актуального стану всіх сесій (POST JSON).
SESSION_HEALTH_PUSH_URL=
```

---

## Запуск у dev
```bash
npm install
node index.js
```

## Збірка `.exe`
```bash
npm run build:exe
```

Або з debug-логом `pkg`:
```bash
npm run build:exe:debug
```

---

## API

### `POST /registerwhatsapp`
Реєстрація/ініціалізація WhatsApp-сесії.

### `POST /sendmsg`
Відправка повідомлення в WhatsApp.

### `GET /status/:phone`
Повертає стан сесії для номера (`connected` / `disconnected`).

### `GET /whatsapp_health`
Повертає стан усіх активних сесій у форматі:
```json
[
  { "phone": "+380...", "status": 1 },
  { "phone": "+380...", "status": 0 }
]
```

### `DELETE /sessiondelete/:phone`
Видаляє активну сесію та локальні дані авторизації/кешу.

---

## Що ще треба зробити в проєкті (next steps)
1. Додати endpoint для **ручного reset/restart** сесії з причиною (для швидкої підтримки без видалення папок вручну).
2. Додати валідацію payload (`zod` або `joi`) для `/registerwhatsapp` і `/sendmsg`.
3. Додати захист API:
   - `rate limit`;
   - секрет/токен між CRM і Node-сервісом.
4. Додати structured logging + `requestId` для кореляції логів CRM/Node.
5. Додати метрики (`/metrics`, Prometheus): reconnect, auth failure, send failures, uptime.
6. Додати health-моніторинг файлової системи (перевірка блокувань `.wwebjs_auth`/`.wwebjs_cache`) і алерти.
7. Описати production runbook (`pm2/systemd`, автостарт, ротація логів, backup сесій).

> Важливо: тести **не потрібно** створювати у репозиторії. За потреби дозволено запускати локальні перевірки лише під час розробки без додавання тестових файлів у git.
