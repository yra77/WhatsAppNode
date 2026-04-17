# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-10, 2-ге оновлення)

### Поточне оточення
- Node.js: `v24.11.1`
- Пакування: `pkg@5.8.1`
- Ціль пакування в проєкті: `node18-win-x64`

### Що змінено сьогодні (фінальні фікси дубль-ініціалізації / статусів)
1. **Зупинено нескінченний цикл `The browser is already running...`:**
   - додано `initializingPhones` (guard від конкурентних `createSession` для одного номера);
   - додано `retryTimers` + `scheduleRetry` (лише один відкладений retry на номер, без накопичення дубльованих таймерів);
   - всі повторні ініціалізації (QR timeout / auth failure / disconnected / send без клієнта) тепер централізовані через `scheduleRetry`.
2. **Виправлено “sessionStatus завжди Неактивна”:**
   - `handleAuthenticatedEvent` тепер виставляє `hasUser: true`;
   - `/status/:phone` більше не покладається лише на `client.authInfo`, а враховує `sessionStatus` і `client.info.wid.user`;
   - endpoint `/status/:phone` тепер повертає поле `state` (наприклад `initializing`, `qr`, `authenticated`, `ready`, `disconnected`).
3. **Виправлено health-звіт для сесій у перехідних станах:**
   - `buildSessionHealthSnapshot()` формує список із об’єднання `clients` + `sessionStatus`, щоб сесії не “зникали” з `/whatsapp_health` під час гонок станів;
   - `hasUser`/`healthy` враховують як мапу стану, так і фактичний стан клієнта.
4. **Покращено контроль життєвого циклу сесії:**
   - при `ready`, `auth_failure`, `disconnected`, `sessiondelete` очищаються всі пов’язані таймери (`QR` + retry) та lock ініціалізації;
   - `/registerwhatsapp` повертає `202 initializing`, якщо сесія вже в процесі старту (замість повторного запуску Chromium).

---

## Вимоги
- Node.js 18+ (рекомендовано LTS)
- npm
- `.env` файл
- Chromium/Google Chrome (локальний або системний)
  - Windows: `./chromium/chrome.exe` (або системний Chrome)
  - Linux/CentOS: системний `google-chrome`/`chromium` або шлях через `CHROME_BIN`

> У `index.js` додано кросплатформений пошук Chromium: `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH` -> локальний `./chromium/*` -> системні Linux-шляхи.

---

## Налаштування
Створіть `.env`:

```env
PORT=3000
BASE_URL=http://localhost:5000
LOG_DIR=Logs
# Опційно: URL для отримання актуального стану всіх сесій (POST JSON).
SESSION_HEALTH_PUSH_URL=
# Опційно: явний шлях до Chrome/Chromium (корисно для CentOS/Linux).
CHROME_BIN=
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

## Запуск на CentOS (7/8/9 Stream)
1. **Встановити Node.js LTS (18/20/22) і базові утиліти**.
2. **Встановити залежності Chromium для headless-режиму** (приклад для CentOS Stream/RHEL-сімейства):
   ```bash
   sudo dnf install -y \
     nss atk cups-libs libdrm libXcomposite libXdamage libXrandr libgbm \
     libxkbcommon pango alsa-lib gtk3 xorg-x11-fonts-Type1 xorg-x11-fonts-misc
   ```
3. **Встановити Chromium або Google Chrome**:
   - або через пакетний менеджер (якщо доступний у вашому репозиторії),
   - або передати явний шлях у `.env`:
   ```env
   CHROME_BIN=/usr/bin/google-chrome-stable
   ```
4. **Запустити сервіс напряму через Node.js** (не `.exe`):
   ```bash
   npm install
   node index.js
   ```

> Для CentOS рекомендовано запуск через `systemd` або `pm2`, а не через `pkg`-бінарник Windows.

## Що саме змінено в коді для CentOS
- Додано кросплатформений пошук бінарника браузера (`resolveChromePath`) із підтримкою Linux/CentOS шляхів.
- Додано підтримку env-перемінних `CHROME_BIN` та `PUPPETEER_EXECUTABLE_PATH`.
- Додано додатковий Chromium-параметр `--disable-software-rasterizer` для більш стабільного headless-запуску на серверних Linux.

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
1. Додати endpoint для **ручного reset/restart** сесії з причиною та примусовим розблокуванням lock/retry-стану (для саппорту без ручного втручання).
2. Додати валідацію payload (`zod` або `joi`) для `/registerwhatsapp`, `/sendmsg`, `/sessiondelete`.
3. Додати захист API:
   - `rate limit`;
   - секрет/токен між CRM і Node-сервісом.
4. Додати structured logging + `requestId` для кореляції логів CRM/Node і дебагу по номеру.
5. Додати метрики (`/metrics`, Prometheus): reconnect, auth failure, qr timeout, retry queue size, send failures, uptime.
6. Додати health-моніторинг файлової системи (перевірка блокувань `.wwebjs_auth`/`.wwebjs_cache`) і алерти.
7. Описати production runbook (`pm2/systemd`, автостарт, ротація логів, backup сесій, процедура відновлення після аварійного reboot).

> Важливо: тести **не потрібно** створювати у репозиторії. За потреби дозволено запускати локальні перевірки лише під час розробки без додавання тестових файлів у git.
