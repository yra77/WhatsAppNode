# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook), адаптований для запуску на CentOS Stream 8/9 і в Docker-контейнері.

## Оновлено: 2026-04-17

## Що актуально зараз
- Сервіс запускається на `APP_HOST` (дефолтно `0.0.0.0`) для зовнішнього доступу на CentOS.
- Є `.env.example` з актуальними змінними оточення.
- Підтримано автопошук Chrome/Chromium у Linux/CentOS (`CHROME_BIN` можна задати явно).
- Додано `Dockerfile` та `.dockerignore` для контейнерного запуску.
- В `PROJECT_MAINTENANCE_NOTES.md` ведеться актуальний стан змін.

## Вимоги (нативний запуск)
- Node.js 18+ (рекомендовано LTS 20/22)
- npm
- Google Chrome або Chromium
- Linux-бібліотеки для headless Chromium

## Швидкий старт (нативно)
```bash
npm install
cp .env.example .env
node index.js
```

## Налаштування `.env`
Заповніть змінні у файлі `.env` (приклад у `.env.example`):

```env
PORT=3000
APP_HOST=0.0.0.0
BASE_URL=http://127.0.0.1:5000
LOG_DIR=Logs
SESSION_HEALTH_PUSH_URL=
CHROME_BIN=/usr/bin/google-chrome-stable
```

---

## Запуск у Docker (рекомендовано для CentOS)

### 1) Збірка образу
```bash
docker build -t whatsappnode:latest .
```

### 2) Підготовка `.env`
```bash
cp .env.example .env
# Відредагуйте BASE_URL, PORT, інші змінні під ваше оточення
```

### 3) Запуск контейнера
```bash
docker run -d --name whatsappnode \
  --env-file .env \
  -p 3000:3000 \
  -v whatsappnode_auth:/app/.wwebjs_auth \
  -v whatsappnode_cache:/app/.wwebjs_cache \
  -v whatsappnode_logs:/app/Logs \
  --restart unless-stopped \
  whatsappnode:latest
```

### 4) Перевірка
```bash
docker logs -f whatsappnode
curl http://127.0.0.1:3000/whatsapp_health
```

> Важливо: сесії WhatsApp зберігаються у volume (`.wwebjs_auth`, `.wwebjs_cache`), тому при перезапуску контейнера повторна авторизація зазвичай не потрібна.

---

## Запуск на CentOS Stream 8/9 (без Docker)

### 1) Встановити Node.js LTS
```bash
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:20 -y
sudo dnf install -y nodejs git
node -v
npm -v
```

### 2) Встановити системні бібліотеки для Chromium
```bash
sudo dnf install -y \
  nss atk cups-libs libdrm libXcomposite libXdamage libXrandr libgbm \
  libxkbcommon pango alsa-lib gtk3 xorg-x11-fonts-Type1 xorg-x11-fonts-misc
```

### 3) Встановити браузер
Один із варіантів:
- `google-chrome-stable`
- `chromium` / `chromium-browser`

Після цього перевірте шлях (`which google-chrome-stable` або `which chromium`) і встановіть `CHROME_BIN` у `.env`, якщо автопошук не спрацював.

### 4) Запустити сервіс
```bash
npm install
cp .env.example .env
node index.js
```

Після запуску API доступний за адресою:
- `http://<SERVER_IP>:3000` (або ваш `PORT`)

Приклад:
- `http://192.168.1.50:3000/status/<phone>`

### 5) Відкрити порт у firewall (за потреби)
```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### 6) (Опційно) SELinux policy
Якщо увімкнений SELinux і є блокування мережевих/файлових дій Node.js — перевірте `audit.log` та додайте дозволи політикою.

## Рекомендований запуск як systemd service
```ini
[Unit]
Description=WhatsAppNode Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/WhatsAppNode
ExecStart=/usr/bin/node /opt/WhatsAppNode/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/WhatsAppNode/.env

[Install]
WantedBy=multi-user.target
```

Після створення unit-файлу:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whatsappnode
sudo systemctl status whatsappnode
```

## API
- `POST /registerwhatsapp` — реєстрація/ініціалізація WhatsApp-сесії.
- `POST /sendmsg` — відправка повідомлення.
- `GET /status/:phone` — стан сесії (`connected`/`disconnected`).
- `GET /whatsapp_health` — масив станів сесій (`[{ phone, status, healthy, hasUser, state, lastUpdate }]`).
- `DELETE /sessiondelete/:phone` — видалення сесії та локальних auth/cache даних.

## Критично для зовнішнього доступу
1. `APP_HOST=0.0.0.0`
2. Відкритий TCP порт у firewall/security group
3. Виклики робіть на `http://<SERVER_IP>:<PORT>`, не на `localhost`
