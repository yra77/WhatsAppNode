# WhatsAppNode

Node.js сервіс інтеграції WhatsApp Web (`whatsapp-web.js`) з CRM (ASP.NET webhook).

## Оновлено: 2026-04-17

### Що зроблено в цій версії
- Додано мережевий запуск через `APP_HOST` (за замовчуванням `0.0.0.0`) — сервіс доступний на CentOS ззовні за `http://<SERVER_IP>:PORT`.
- Оновлено інструкцію запуску під CentOS (Node.js + Chrome/Chromium + firewall + systemd).
- Додано технічний файл `PROJECT_MAINTENANCE_NOTES.md` для фіксації виконаних змін і backlog.

## Вимоги
- Node.js 18+ (рекомендовано LTS 20/22)
- npm
- Chromium/Google Chrome
- `.env`

## Налаштування `.env`
```env
# Порт API
PORT=3000

# На якій адресі слухати HTTP-сервер.
# Для CentOS/VPS використовуйте 0.0.0.0, щоб був доступ з мережі.
APP_HOST=0.0.0.0

# URL вашого CRM/бекенду для webhook-викликів
BASE_URL=http://127.0.0.1:5000

# Каталог логів
LOG_DIR=Logs

# Опційно: URL для отримання актуального стану всіх сесій (POST JSON)
SESSION_HEALTH_PUSH_URL=

# Опційно: явний шлях до Chrome/Chromium (особливо актуально для Linux/CentOS)
CHROME_BIN=/usr/bin/google-chrome-stable
```

## Локальний запуск
```bash
npm install
node index.js
```

## Запуск на CentOS (Stream 8/9)

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

### 3) Встановити Chrome/Chromium і вказати `CHROME_BIN`
- або системний пакет `google-chrome-stable`/`chromium`
- або вручну встановлений браузер з повним шляхом у `.env`

### 4) Запустити сервіс
```bash
npm install
node index.js
```

Після запуску сервіс буде доступний за адресою:
- `http://<SERVER_IP>:3000` (або ваш `PORT`)

> Приклад: якщо IP сервера `192.168.1.50`, тоді виклик: `http://192.168.1.50:3000/status/<phone>`.

### 5) Відкрити порт у firewall (за потреби)
```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

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
- `GET /whatsapp_health` — масив станів сесій (`[{ phone, status }]`).
- `DELETE /sessiondelete/:phone` — видалення сесії і локальних auth/cache даних.

## Важливо про адресу сервісу
- Раніше часто використовували `localhost` (інколи з помилкою `lcalhost`).
- Для зовнішнього доступу на CentOS потрібно:
  1. `APP_HOST=0.0.0.0`
  2. відкритий порт у firewall/security group
  3. викликати сервіс за `http://<SERVER_IP>:<PORT>`
