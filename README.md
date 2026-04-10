# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-10)

### Поточне оточення
- Node.js: `v24.11.1`
- Пакування: `pkg@5.8.1`
- Ціль пакування в проєкті: `node18-win-x64`

### Що оновлено в останніх змінах
1. Виправлено обробку вхідних повідомлень у `handleMessageEvent` для нових WhatsApp ідентифікаторів `@lid`:
   - перевірка індивідуального чату тепер робиться через `message.getChat()` + `chat.isGroup`;
   - повідомлення від `@lid` більше не пропускаються з причиною «не є індивідуальним чатом».
2. Додано helper-функції для коректної роботи з JID:
   - `isDirectUserJid(jid)` — підтримка `@c.us` та `@lid`;
   - `extractUserIdFromJid(jid)` — виділення user-id із JID;
   - `resolveContactIdentifier(contact, fallbackJid)` — пріоритетно повертає номер контакту, а якщо його немає — user-id.
3. Перевірку «вхідне/вихідне» змінено на `message.fromMe`, щоб уникнути помилкових пропусків при `@lid`.
4. У payload webhook (`metadata`) додано `receiver_id`, щоб сервер отримував ідентифікатор отримувача навіть коли це `@lid`.

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
1. Додати валідацію payload (`zod` або `joi`) для `/registerwhatsapp` і `/sendmsg`.
2. Уніфікувати формат ідентифікаторів у CRM:
   - зберігати і `phone`, і `jid/userId`;
   - додати мапінг `lid -> phone`, якщо в бізнес-логіці обов'язково потрібен саме номер телефону.
3. Додати захист API:
   - `rate limit`;
   - секрет/токен між CRM і Node-сервісом.
4. Додати structured logging + `requestId` для кореляції логів CRM/Node.
5. Описати production runbook (`pm2/systemd`, автостарт, ротація логів, backup сесій).
6. Додати метрики (`/metrics`, Prometheus): reconnect, auth failure, send failures, uptime.

> Важливо: тести **не потрібно** створювати у репозиторії. За потреби дозволено запускати локальні перевірки лише під час розробки без додавання тестових файлів у git.
