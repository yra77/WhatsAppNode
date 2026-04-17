# Dockerfile для запуску WhatsAppNode у контейнері на Docker-хості (включно з CentOS).
# Базовий образ містить Node.js 20 LTS і сумісні Debian-пакети для Chromium.
FROM node:20-bookworm-slim

# Встановлюємо Chromium та бібліотеки, потрібні для whatsapp-web.js / Puppeteer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Робоча директорія застосунку.
WORKDIR /app

# Спочатку копіюємо package файли для кешованого npm ci.
COPY package*.json ./

# Встановлення production-залежностей.
RUN npm ci --omit=dev

# Копіюємо код застосунку.
COPY . .

# Окремий непривілейований користувач для безпечного запуску.
RUN useradd -m -u 1001 appuser \
 && mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/Logs \
 && chown -R appuser:appuser /app

USER appuser

# Явно фіксуємо порт і шлях Chromium для стабільного запуску в контейнері.
ENV NODE_ENV=production \
    PORT=3000 \
    APP_HOST=0.0.0.0 \
    CHROME_BIN=/usr/bin/chromium

EXPOSE 3000

# Точки монтування для постійного збереження сесій та логів.
VOLUME ["/app/.wwebjs_auth", "/app/.wwebjs_cache", "/app/Logs"]

# Основна команда запуску сервісу.
CMD ["node", "index.js"]
