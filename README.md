# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Актуальний стан (оновлено 2026-04-10)

### Поточне оточення
- Node.js: `v24.11.1`
- Пакування: `pkg@5.8.1`
- Ціль пакування в проєкті: `node18-win-x64` (це нормально для `pkg@5.8.1`)

### Що оновлено в останніх змінах
1. У `index.js` додано облік актуального стану сесій (`sessionStatus`) та оновлення стану на подіях `qr`, `authenticated`, `ready`, `auth_failure`, `disconnected`, `sessiondelete`.
2. Додано endpoint `GET /whatsapp_health` (сумісний формат із `index_old.js`): масив `[{ phone, status }]`, де `status: 1` — сесія жива, `status: 0` — неактивна.
3. Додано опціональну синхронізацію стану сесій на зовнішній сервер:
   - через змінну `.env`: `SESSION_HEALTH_PUSH_URL`
   - push виконується при змінах стану сесії та періодично (раз на 60 секунд).
4. README оновлено: прибрано неактуальні пункти, додано інструкції по health-моніторингу.

---

## Пояснення щодо попередніх warning-ів `pkg`

### 1) `Cannot include directory ... node_modules\puppeteer\.local-chromium`
Це очікувана поведінка `pkg`: каталоги браузера Puppeteer не вбудовуються у `.exe` як snapshot-ресурси.

Що робимо:
- очищаємо dev-каталог `.local-chromium` через `npm run prepare:pkg`;
- використовуємо локальний Chromium із `./chromium/chrome.exe` під час runtime (логіка вже є в `index.js`);
- якщо потрібно, розповсюджуємо `chromium/` поруч з `whatsappserver3.exe`.

### 2) `Babel parse has failed ... typed-query-selector/shim.d.ts`
Це побічний warning під час проходу `pkg` по залежностях TypeScript declaration (`.d.ts`).
На роботу runtime зазвичай не впливає.

Що робити:
- для перевірки запускати `npm run build:exe:debug`;
- якщо `.exe` стартує і WhatsApp-сесія працює, warning можна вважати некритичним;
- за потреби наступний крок — пін або оновлення дерева залежностей (`whatsapp-web.js`/`puppeteer`) після тесту сумісності.

---

## Вимоги
- Windows Server/Windows 10+ для `.exe`
- Node.js 18+ (локально у вас зараз Node 24.11.1)
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
2. Додати захист API:
   - `rate limit`;
   - секрет/токен між CRM і Node-сервісом.
3. Додати structured logging + `requestId` для кореляції логів CRM/Node.
4. Описати production runbook (`pm2/systemd`, автостарт, ротація логів, backup сесій).
5. Додати метрики (`/metrics`, Prometheus): reconnect, auth failure, send failures, uptime.

> Важливо: тести **не потрібно** створювати у репозиторії. За потреби дозволено запускати локальні перевірки лише під час розробки без додавання тестових файлів у git.
