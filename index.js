require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { Logger: logger, LogLevels } = require('./logger');
const app = express();

// Шлях до локального Chromium у корені проєкту (Windows-бінарник).
// Якщо файла немає — використовуємо Chromium/Puppeteer за замовчуванням бібліотеки.
const localChromePath = path.join(process.cwd(), 'chromium', 'chrome.exe');
const chromePath = fs.existsSync(localChromePath) ? localChromePath : undefined;

app.use(express.json());

// Перевірка наявності BASE_URL
if (!process.env.BASE_URL) {
    logger.log(`❌ BASE_URL не задано в .env. Використовую локальну URL за замовчуванням: http://localhost:3000`, LogLevels.Warning, 'index');
    process.env.BASE_URL = 'http://localhost:3000'; // Резервний URL
    // Не завершуємо процес, а продовжуємо з резервним значенням
}

// Визначення директорій для сесій
const BASE_DIR = process.cwd();
const AUTH_DIR = path.join(BASE_DIR, '.wwebjs_auth');
const CACHE_DIR = path.join(BASE_DIR, '.wwebjs_cache');
fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync(CACHE_DIR);

// Всі активні клієнти та таймери
const clients = new Map();
const qrTimers = new Map();
// Стан сесій для health-check та синхронізації з CRM/сервером.
const sessionStatus = new Map();

// Функція для очищення таймерів
function clearQrTimer(phoneNumber) {
    if (qrTimers.has(phoneNumber)) {
        clearTimeout(qrTimers.get(phoneNumber));
        qrTimers.delete(phoneNumber);
    }
}

// Функція для нормалізації телефонного номера (ключ для Map/роутів).
function normalizePhone(phoneNumber) {
    return String(phoneNumber || '').trim();
}

// Оновлення health-стану для конкретної сесії.
function setSessionHealth(phoneNumber, updates = {}) {
    const current = sessionStatus.get(phoneNumber) || {
        healthy: false,
        hasUser: false,
        state: 'disconnected',
        lastUpdate: Date.now()
    };

    const next = {
        ...current,
        ...updates,
        lastUpdate: Date.now()
    };

    sessionStatus.set(phoneNumber, next);
    return next;
}

// Формування поточного snapshot усіх сесій для віддачі в endpoint і синхронізації на сервер.
function buildSessionHealthSnapshot() {
    const result = [];

    for (const [phone, client] of clients.entries()) {
        const state = sessionStatus.get(phone) || {};
        const healthy = state.healthy === true && state.hasUser === true && !!client?.info?.wid?.user;

        result.push({
            phone,
            status: healthy ? 1 : 0,
            healthy,
            hasUser: state.hasUser === true,
            state: state.state || 'unknown',
            lastUpdate: state.lastUpdate || Date.now()
        });
    }

    return result;
}

// Передаємо актуальний стан сесій на зовнішній сервер (якщо налаштовано SESSION_HEALTH_PUSH_URL).
async function pushSessionHealthToServer(reason = 'periodic') {
    const targetUrl = process.env.SESSION_HEALTH_PUSH_URL;
    if (!targetUrl) {
        return;
    }

    const payload = {
        source: 'whatsapp-node',
        reason,
        timestamp: new Date().toISOString(),
        sessions: buildSessionHealthSnapshot()
    };

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            logger.log(`Не вдалося передати стан сесій. HTTP ${response.status}`, LogLevels.Warning, 'healthPush');
            return;
        }

        logger.log(`Стан сесій успішно передано (${payload.sessions.length} сесій)`, LogLevels.Info, 'healthPush');
    } catch (err) {
        logger.log(`Помилка передачі стану сесій: ${err.message}`, LogLevels.Warning, 'healthPush');
    }
}

// Функція для отримання шляху до сесії
function getSessionPath(phoneNumber) {
    const cleanedClientId = phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(AUTH_DIR, `session-${cleanedClientId}`);
}

// Функція для отримання шляху до кешу
function getCachePath(phoneNumber) {
    const cleanedClientId = phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(CACHE_DIR, `cache-${cleanedClientId}`);
}

// Функція для затримки
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Функція для отримання списку зареєстрованих номерів із ASP.NET
async function fetchRegisteredPhones(maxRetries = 5, retryDelay = 30000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(`${process.env.BASE_URL}/whatsapp?handler=RegisteredPhones`);
            if (!response.ok || response.status === 204) {
                throw new Error(`Помилка HTTP: ${response.status}`);
            }
            const data = await response.json();
            logger.log(`Отримано список зареєстрованих номерів: ${JSON.stringify(data)}`, LogLevels.Info, 'fetchRegisteredPhones');

            if (!data || !Array.isArray(data) || data.length === 0) {
                logger.log('Список зареєстрованих номерів порожній. Повторні запити не потрібні.', LogLevels.Info, 'fetchRegisteredPhones');
                return [];
            }

            return data;
        } catch (err) {
            logger.log(`Спроба ${attempt}/${maxRetries}. Помилка при отриманні зареєстрованих номерів: ${err.message}`, LogLevels.Error, 'fetchRegisteredPhones');
            if (attempt === maxRetries) {
                logger.log(`Досягнуто максимальну кількість спроб (${maxRetries}). Продовжую роботу без зареєстрованих номерів.`, LogLevels.Warning, 'fetchRegisteredPhones');
                return []; // Повертаємо порожній список і продовжуємо
            }
            logger.log(`Очікування ${retryDelay / 1000} секунд перед наступною спробою...`, LogLevels.Info, 'fetchRegisteredPhones');
            await delay(retryDelay);
        }
    }
    logger.log('Невідома помилка в циклі fetchRegisteredPhones. Повертаю порожній список.', LogLevels.Warning, 'fetchRegisteredPhones');
    return [];
}

// Ініціалізація всіх зареєстрованих сесій
async function initializeRegisteredSessions() {
    try {
        const registeredPhones = await fetchRegisteredPhones();
        if (!registeredPhones || registeredPhones.length === 0) {
            logger.log('Немає зареєстрованих номерів для ініціалізації', LogLevels.Info, 'initializeRegisteredSessions');
            return;
        }

        for (const { phoneNumber, lineId } of registeredPhones) {
            const normalizedPhone = normalizePhone(phoneNumber);
            const cleanedClientId = normalizedPhone.replace(/[^a-zA-Z0-9_-]/g, '');
            const sessionPath = getSessionPath(normalizedPhone);

            if (fs.existsSync(sessionPath)) {
                logger.log(`Знайдено збережену сесію для ${normalizedPhone}, ініціалізація...`, LogLevels.Info, 'initializeRegisteredSessions');

                const client = new Client({
                    authStrategy: new LocalAuth({ clientId: cleanedClientId, dataPath: AUTH_DIR }),
                    puppeteer: {
                        executablePath: chromePath,
                        headless: true,
                        args: ['--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-gpu',
                            '--disable-dev-shm-usage',
                            '--disable-accelerated-2d-canvas',
                            '--no-first-run',
                            '--no-zygote',
                            '--single-process',   // Sometimes helps on Windows
                            '--disable-background-timer-throttling']
                    }
                });

                clients.set(normalizedPhone, client);
                // Сесія відновлюється із збережених даних, очікуємо подію ready/authenticated.
                setSessionHealth(normalizedPhone, { healthy: false, hasUser: false, state: 'restoring' });

                // Важливо: у callback передаємо реальний номер, а не cleanedClientId,
                // щоб коректно працювали notify URL, пошук клієнта та cleanup.
                client.on('ready', handleReadyEvent(normalizedPhone, lineId));
                client.on('authenticated', handleAuthenticatedEvent(normalizedPhone));
                client.on('auth_failure', handleAuthFailureEvent(normalizedPhone));
                client.on('disconnected', handleDisconnectedEvent(normalizedPhone));
                client.on('message', (message) => handleMessageEvent(message, normalizedPhone));

                try {
                    await client.initialize();
                } catch (err) {
                    logger.log(`Помилка ініціалізації клієнта WhatsApp для ${normalizedPhone}: ${err.message}. Спроба переініціалізації через 30 секунд.`, LogLevels.Error, 'initializeRegisteredSessions');
                    clients.delete(normalizedPhone);
                    setTimeout(() => initializeClient(normalizedPhone, lineId), 30000); // Перезапуск через 30 секунд
                }
            } else {
                logger.log(`Немає збереженої сесії для ${normalizedPhone}, пропускаємо ініціалізацію`, LogLevels.Warning, 'initializeRegisteredSessions');
            }
        }
    } catch (err) {
        logger.log(`Критична помилка в initializeRegisteredSessions: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'initializeRegisteredSessions');
    }
}

// Функція для повторної ініціалізації клієнта
function initializeClient(phoneNumber, lineId) {
    const normalizedPhone = normalizePhone(phoneNumber);
    const cleanedClientId = normalizedPhone.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionPath = getSessionPath(normalizedPhone);
    if (fs.existsSync(sessionPath)) {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: cleanedClientId, dataPath: AUTH_DIR }),
            puppeteer: {
                executablePath: chromePath,
                headless: true,
                args: ['--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',   // Sometimes helps on Windows
                    '--disable-background-timer-throttling']
            }
        });

        clients.set(normalizedPhone, client);
        // Повторна ініціалізація: фіксуємо проміжний стан до ready.
        setSessionHealth(normalizedPhone, { healthy: false, hasUser: false, state: 'reinitializing' });

        client.on('ready', handleReadyEvent(normalizedPhone, lineId));
        client.on('authenticated', handleAuthenticatedEvent(normalizedPhone));
        client.on('auth_failure', handleAuthFailureEvent(normalizedPhone));
        client.on('disconnected', handleDisconnectedEvent(normalizedPhone));
        client.on('message', (message) => handleMessageEvent(message, normalizedPhone));

        client.initialize().catch((err) => {
            logger.log(`Помилка повторної ініціалізації для ${normalizedPhone}: ${err.message}. Спроба через 30 секунд.`, LogLevels.Error, 'initializeClient');
            clients.delete(normalizedPhone);
            setTimeout(() => initializeClient(normalizedPhone, lineId), 30000);
        });
    }
}

// Обробка QR-коду
function handleQrEvent(client, phoneNumber, res) {

    logger.log(`QR generated for ${phoneNumber}`, LogLevels.Info, 'handleQrEvent');

    return async (qr) => {
        try {
            // Поки активний QR, сесія ще не вважається healthy.
            setSessionHealth(phoneNumber, { healthy: false, hasUser: false, state: 'qr' });
            await pushSessionHealthToServer('qr');
            const qrImage = await qrcode.toDataURL(qr);
            res.json({ status: 'qr', qr: qrImage, phone: phoneNumber });
            qrTimers.set(phoneNumber, setTimeout(() => {
                if (!client.authInfo) {
                    client.destroy();
                    clients.delete(phoneNumber);
                    clearQrTimer(phoneNumber);

                    removeSessionData(phoneNumber);

                    logger.log(`Час на сканування QR-коду для ${phoneNumber} минув`, LogLevels.Warning, 'handleQrEvent');
                    setTimeout(() => createSession(phoneNumber, null, { headersSent: true }), 30000);
                }
            }, 30000));
        } catch (err) {
            logger.log(`Помилка обробки QR-коду для ${phoneNumber}: ${err.message}. Продовжую роботу.`, LogLevels.Error, 'handleQrEvent');
        }
    };
}

// Обробка успішного підключення
function handleReadyEvent(phoneNumber, lineId, res = { headersSent: false }) {
    return async () => {
        try {
            logger.log(`WhatsApp підключено: ${phoneNumber}`, LogLevels.Info, 'handleReadyEvent');
            // Сесія готова до роботи та має підключеного користувача.
            setSessionHealth(phoneNumber, { healthy: true, hasUser: true, state: 'ready' });
            await pushSessionHealthToServer('ready');
            clearQrTimer(phoneNumber);

            const notifyUrl = `${process.env.BASE_URL}/whatsapp?handler=NotifyAuthSuccess&phone=${encodeURIComponent(phoneNumber)}&lineId=${encodeURIComponent(lineId || '')}`;
            const notifyRes = await fetch(notifyUrl);
            if (!notifyRes.ok) {
                logger.log(`Помилка при повідомленні ASP.NET для ${phoneNumber}: ${notifyRes.statusText}`, LogLevels.Warning, 'handleReadyEvent');
            } else {
                const notifyData = await notifyRes.json();
                logger.log(`ASP.NET повідомлено про успішну автентифікацію ${phoneNumber}: ${JSON.stringify(notifyData)}`, LogLevels.Info, 'handleReadyEvent');
            }

            // Перевіряємо, чи res має метод json (тобто це Express-відповідь)
            if (!res.headersSent && typeof res.json === 'function') {
                res.json({ status: 'success', message: 'Автентифікація успішна', phone: phoneNumber, lineId });
            }
            clearQrTimer(phoneNumber);
        } catch (err) {
            logger.log(`Помилка в handleReadyEvent для ${phoneNumber}: ${err.message}. Продовжую роботу.`, LogLevels.Error, 'handleReadyEvent');
        }
    };
}

// Обробка автентифікації
function handleAuthenticatedEvent(phoneNumber) {
    return () => {
        logger.log(`Аутентифікація успішна: ${phoneNumber}`, LogLevels.Success, 'handleAuthenticatedEvent');
        // Авторизація пройдена, але повна готовність фіксується в ready.
        setSessionHealth(phoneNumber, { healthy: true, state: 'authenticated' });
        clearQrTimer(phoneNumber);
    };
}

// Обробка помилки автентифікації
function handleAuthFailureEvent(phoneNumber, res = { headersSent: false }) {
    return async (msg) => {
        logger.log(`Помилка авторизації: ${phoneNumber} - ${msg}`, LogLevels.Error, 'handleAuthFailureEvent');
        setSessionHealth(phoneNumber, { healthy: false, hasUser: false, state: 'auth_failure' });
        await pushSessionHealthToServer('auth_failure');
        if (!res.headersSent) {
            res.status(401).json({ status: 'error', message: 'Помилка авторизації' });
        }
        clients.delete(phoneNumber);
        clearQrTimer(phoneNumber);
        setTimeout(() => createSession(phoneNumber, null, { headersSent: true }), 30000); // Повторна спроба
    };
}

// Обробка відключення
function handleDisconnectedEvent(phoneNumber) {
    return async (reason) => {
        logger.log(`Відключено: ${phoneNumber} - ${reason}`, LogLevels.Warning, 'handleDisconnectedEvent');
        setSessionHealth(phoneNumber, { healthy: false, hasUser: false, state: 'disconnected' });
        await pushSessionHealthToServer('disconnected');
        clients.delete(phoneNumber);
        clearQrTimer(phoneNumber);
        setTimeout(() => initializeClient(phoneNumber, null), 30000); // Повторна ініціалізація
    };
}

// async function handleMessageEvent(message, phoneNumber) {
//     try {
//         // Перевіряємо, чи повідомлення від індивідуального контакту (@c.us)
//         if (!message.from.endsWith('@c.us') || !message.to.endsWith('@c.us')) {
//             logger.log(`Повідомлення від ${message.from} до ${message.to} пропущено: не є індивідуальним чатом`, LogLevels.Info, 'handleMessageEvent');
//             return;
//         }
//         // Перевіряємо, що повідомлення вхідне
//         if (message.from === `${phoneNumber}@c.us`) {
//             logger.log(`Повідомлення від ${message.from} до ${message.to} пропущено: це вихідне повідомлення`, LogLevels.Info, 'handleMessageEvent');
//             return;
//         }

//         const fromPhone = message.from.replace('@c.us', '');
//         const toPhone = message.to.replace('@c.us', '');
//         const messageId = message.id.id;
//         const timestamp = message.timestamp;
//         const type = message.type;

//         let messageText = '';
//         let mediaData = null;

//         switch (type) {
//             case 'chat':
//             case 'text':
//                 messageText = message.body;
//                 break;
//             case 'image':
//             case 'video':
//             case 'audio':
//             case 'document':
//             case 'sticker':
//                 messageText = message.body || type;
//                 const media = await message.downloadMedia();
//                 if (media) {
//                     const sessionFolder = `whatsapp_${phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '')}`;
//                     const filesDirectory = path.join(BASE_DIR, sessionFolder, 'files');
//                     if (!fs.existsSync(filesDirectory)) {
//                         fs.mkdirSync(filesDirectory, { recursive: true });
//                     }

//                     const fileSizeInBytes = Buffer.from(media.data, 'base64').length;
//                     const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

//                     if (fileSizeInMB > 16) {
//                         logger.log(`Файл ${type}_${messageId} занадто великий: ${fileSizeInMB.toFixed(2)} МБ (>16 МБ)`, LogLevels.Warning, 'handleMessageEvent');
//                         messageText = "занадто великий файл. не вдалося відправити";
//                         break;
//                     }

//                     const mimeType = media.mimetype || `${type}/${type === 'sticker' ? 'webp' : type === 'audio' ? 'ogg' : type === 'video' ? 'mp4' : 'jpg'}`;
//                     const filename = message.filename || `${type}_${messageId}.${mimeType.split('/')[1] || 'unknown'}`;
//                     const filePath = path.join(filesDirectory, filename);
//                     fs.writeFileSync(filePath, media.data, 'base64');
//                     logger.log(`Медіафайл ${filename} збережено за шляхом: ${filePath}`, LogLevels.Info, 'handleMessageEvent');
//                     mediaData = {
//                         id: messageId,
//                         mimeType: mimeType,
//                         caption: message.caption || '',
//                         filename: filePath
//                     };
//                 } else {
//                     messageText = `${type} (не вдалося завантажити)`;
//                 }
//                 break;
//             case 'reaction':
//                 messageText = `Реакція: ${message.reaction} на повідомлення ${message.id.remote}`;
//                 break;
//             default:
//                 messageText = `Невідомий тип: ${type}`;
//         }

//         const payload = {
//             entry: [{
//                 changes: [{
//                     value: {
//                         messages: [{
//                             id: messageId,
//                             from: fromPhone,
//                             timestamp: timestamp,
//                             type: type,
//                             text: { body: messageText },
//                             [type]: mediaData
//                         }],
//                         metadata: {
//                             phone_number_id: phoneNumber
//                         }
//                     }
//                 }]
//             }]
//         };

//         logger.log(`Отримано повідомлення від ${fromPhone}: ${messageText}`, LogLevels.Info, 'handleMessageEvent');
//         try {
//             const response = await fetch(`${process.env.BASE_URL}/whatsappwebhook`, {
//                 method: 'POST',
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify(payload)
//             });
//             if (!response.ok) {
//                 logger.log(`Помилка відправлення до ASP.NET: ${response.statusText}`, LogLevels.Warning, 'handleMessageEvent');
//             } else {
//                 logger.log(`Повідомлення відправлено до ${process.env.BASE_URL}/whatsappwebhook`, LogLevels.Success, 'handleMessageEvent');
//             }
//         } catch (err) {
//             logger.log(`Помилка надсилання до ASP.NET: ${err.message}. Продовжую обробку інших повідомлень.`, LogLevels.Error, 'handleMessageEvent');
//         }
//     } catch (err) {
//         logger.log(`Нештатна ситуація в handleMessageEvent: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'handleMessageEvent');
//     }
// }
async function handleMessageEvent(message, phoneNumber) {
    try {
        // Перевіряємо, чи повідомлення від індивідуального контакту (@c.us)
        if (!message.from.endsWith('@c.us') || !message.to.endsWith('@c.us')) {
            logger.log(`Повідомлення від ${message.from} до ${message.to} пропущено: не є індивідуальним чатом`, LogLevels.Info, 'handleMessageEvent');
            return;
        }
        // Перевіряємо, що повідомлення вхідне
        if (message.from === `${phoneNumber}@c.us`) {
            logger.log(`Повідомлення від ${message.from} до ${message.to} пропущено: це вихідне повідомлення`, LogLevels.Info, 'handleMessageEvent');
            return;
        }

        const fromPhone = message.from.replace('@c.us', '');
        const toPhone = message.to.replace('@c.us', '');
        const messageId = message.id.id;
        const timestamp = message.timestamp;
        const type = message.type;

        let messageText = '';
        let mediaData = null;

        switch (type) {
            case 'chat':
            case 'text':
                messageText = message.body;
                break;
            case 'image':
            case 'video':
            case 'audio':
            case 'document':
            case 'sticker':
                messageText = message.body || type;
                const media = await message.downloadMedia();
                if (media) {
                    const sessionFolder = `whatsapp_${phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '')}`;
                    const filesDirectory = path.join(BASE_DIR, sessionFolder, 'files');
                    if (!fs.existsSync(filesDirectory)) {
                        fs.mkdirSync(filesDirectory, { recursive: true });
                    }

                    const fileSizeInBytes = Buffer.from(media.data, 'base64').length;
                    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

                    if (fileSizeInMB > 100) {
                        logger.log(`Файл ${type}_${messageId} занадто великий: ${fileSizeInMB.toFixed(2)} МБ (>100 МБ)`, LogLevels.Warning, 'handleMessageEvent');
                        messageText = "занадто великий файл. не вдалося відправити";
                        break;
                    }

                    const mimeType = media.mimetype || `${type}/${type === 'sticker' ? 'webp' : type === 'audio' ? 'ogg' : type === 'video' ? 'mp4' : type === 'document' ? 'octet-stream' : 'jpg'}`;
                    const filename = message.filename || `${type}_${messageId}.${mimeType.split('/')[1] || 'unknown'}`;
                    const filePath = path.join(filesDirectory, filename);
                    fs.writeFileSync(filePath, media.data, 'base64');
                    logger.log(`Медіафайл ${filename} збережено за шляхом: ${filePath}`, LogLevels.Info, 'handleMessageEvent');
                    mediaData = {
                        id: messageId,
                        mimeType: mimeType,
                        caption: message.caption || '',
                        filename: filePath
                    };
                } else {
                    messageText = `${type} (не вдалося завантажити)`;
                }
                break;
            case 'reaction':
                messageText = `Реакція: ${message.reaction} на повідомлення ${message.id.remote}`;
                break;
            default:
                messageText = `Невідомий тип: ${type}`;
        }

        const payload = {
            entry: [{
                changes: [{
                    value: {
                        messages: [{
                            id: messageId,
                            from: fromPhone,
                            timestamp: timestamp,
                            type: type,
                            text: { body: messageText },
                            [type]: mediaData
                        }],
                        metadata: {
                            phone_number_id: phoneNumber
                        }
                    }
                }]
            }]
        };

        logger.log(`Отримано повідомлення від ${fromPhone}: ${messageText}`, LogLevels.Info, 'handleMessageEvent');
        try {
            const response = await fetch(`${process.env.BASE_URL}/whatsappwebhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                logger.log(`Помилка відправлення до ASP.NET: ${response.statusText}`, LogLevels.Warning, 'handleMessageEvent');
            } else {
                logger.log(`Повідомлення відправлено до ${process.env.BASE_URL}/whatsappwebhook`, LogLevels.Success, 'handleMessageEvent');
            }
        } catch (err) {
            logger.log(`Помилка надсилання до ASP.NET: ${err.message}. Продовжую обробку інших повідомлень.`, LogLevels.Error, 'handleMessageEvent');
        }
    } catch (err) {
        logger.log(`Нештатна ситуація в handleMessageEvent: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'handleMessageEvent');
    }
}

// Ініціалізація сесії
function createSession(phoneNumber, lineId, res) {
    try {
        const normalizedPhone = normalizePhone(phoneNumber);
        const cleanedClientId = normalizedPhone.replace(/[^a-zA-Z0-9_-]/g, '');
        const sessionPath = getSessionPath(normalizedPhone);
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: cleanedClientId, dataPath: AUTH_DIR }),
            puppeteer: {
                executablePath: chromePath,
                headless: true,
                args: ['--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',   // Sometimes helps on Windows
                    '--disable-background-timer-throttling']
            }
        });
        clients.set(normalizedPhone, client);
        // Після створення клієнта відмічаємо сесію як стартовану, але ще не готову.
        setSessionHealth(normalizedPhone, { healthy: false, hasUser: false, state: 'initializing' });

        if (!client) {
            throw new Error("Client instance is null after creation");
        }

        client.on('qr', handleQrEvent(client, normalizedPhone, res));
        client.on('ready', handleReadyEvent(normalizedPhone, lineId, res));
        client.on('authenticated', handleAuthenticatedEvent(normalizedPhone));
        client.on('auth_failure', handleAuthFailureEvent(normalizedPhone, res));
        client.on('disconnected', handleDisconnectedEvent(normalizedPhone));
        client.on('message', (message) => handleMessageEvent(message, normalizedPhone));

        client.initialize().then(() => {
            logger.log(`Initialize success for ${normalizedPhone}`, LogLevels.Success, 'init');
        }).catch((err) => {
            logger.log(`Помилка ініціалізації клієнта WhatsApp для ${normalizedPhone}: ${err.message}. Спроба переініціалізації через 30 секунд.`, LogLevels.Error, 'createSession');
            clients.delete(normalizedPhone);
            setTimeout(() => createSession(normalizedPhone, lineId, { headersSent: true }), 30000);
        });
    } catch (err) {
        logger.log(`Нештатна ситуація в createSession для ${phoneNumber}: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'createSession');
    }
}


// Функція для видалення теки сесії
function removeSessionData(phoneNumber) {
    const sessionPath = getSessionPath(phoneNumber);
    const cachePath = getCachePath(phoneNumber);

    if (fs.existsSync(sessionPath)) {
        try {
            fs.removeSync(sessionPath);
            logger.log(`Каталог сесії видалено: ${sessionPath}`, LogLevels.Info, 'session');
        } catch (err) {
            logger.log(`Помилка видалення каталогу сесії ${sessionPath}: ${err.message}`, LogLevels.Error, 'session');
        }
    }

    if (fs.existsSync(cachePath)) {
        try {
            fs.removeSync(cachePath);
            logger.log(`Каталог кешу видалено: ${cachePath}`, LogLevels.Info, 'session');
        } catch (err) {
            logger.log(`Помилка видалення каталогу кешу ${cachePath}: ${err.message}`, LogLevels.Error, 'session');
        }
    }
}

// Отримання даних від ASP.NET для старту реєстрації
app.post('/registerwhatsapp', async (req, res) => {
    try {
        const { phone, lineId } = req.body;
        if (!phone) {
            logger.log('Phone number is required', LogLevels.Error, 'register');
            return res.status(400).json({ status: 'error', message: 'Phone number is required' });
        }

        const normalizedPhone = normalizePhone(phone);
        const sessionPath = getSessionPath(normalizedPhone);
        if (clients.has(normalizedPhone) || fs.existsSync(sessionPath)) {
            logger.log(`Сесія вже існує або активна для ${normalizedPhone}`, LogLevels.Info, 'register');
            return res.status(200).json({ status: 'connected', message: 'Сесія вже існує або активна', phone: normalizedPhone, lineId });
        }

        createSession(normalizedPhone, lineId, res);
    } catch (err) {
        logger.log(`Помилка в /registerwhatsapp для ${req.body.phone}: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'register');
        res.status(500).json({ status: 'error', message: 'Внутрішня помилка сервера' });
    }
});

// Отримання повідомлення з ASP.NET
app.post('/sendmsg', async (req, res) => {
    try {
        const { from, to, message, contentType = 'text', filePath, bitrixMessageId } = req.body;

        if (!from || !to || !message) {
            logger.log(`Некоректні параметри: from=${from}, to=${to}, message=${message}`, LogLevels.Error, 'send');
            return res.status(400).json({ status: 'error', message: 'Необхідні параметри: from, to, message' });
        }

        const normalizedFrom = normalizePhone(from);
        const client = clients.get(normalizedFrom);
        if (!client) {
            logger.log(`Клієнт не підключений для ${normalizedFrom}. Спроба переініціалізації через 30 секунд.`, LogLevels.Warning, 'send');
            setTimeout(() => createSession(normalizedFrom, null, { headersSent: true }), 30000); // Повторна спроба
            return res.status(404).json({ status: 'error', message: 'Клієнт не підключений' });
        }

        const chatId = `${to}@c.us`;
        let sentMessage;

        if (contentType === 'text') {
            sentMessage = await client.sendMessage(chatId, message);
        } else if (filePath) {
            if (!fs.existsSync(filePath)) {
                logger.log(`Файл не знайдено: ${filePath}`, LogLevels.Error, 'send');
                return res.status(400).json({ status: 'error', message: `Файл не знайдено: ${filePath}` });
            }
            const fileData = fs.readFileSync(filePath, 'base64');
            const mediaMsg = new MessageMedia(contentType, fileData, path.basename(filePath));
            sentMessage = await client.sendMessage(chatId, mediaMsg, { caption: message });
        } else {
            logger.log(`Непідтримуваний contentType: ${contentType}`, LogLevels.Error, 'send');
            return res.status(400).json({ status: 'error', message: `Непідтримуваний contentType: ${contentType}` });
        }

        const messageId = sentMessage?.id?.id || require('crypto').randomBytes(8).toString('hex');
        logger.log(`Повідомлення відправлено від ${normalizedFrom} до ${to}, messageId: ${messageId}, contentType: ${contentType}`, LogLevels.Success, 'send');

        res.json({
            status: 'sent',
            messageId: messageId,
            bitrixMessageId: bitrixMessageId
        });
    } catch (err) {
        logger.log(`Помилка відправлення повідомлення від ${req.body.from} до ${req.body.to}: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'send');
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Отримання статусу сесії
app.get('/status/:phone', (req, res) => {
    try {
        // У статусі використовуємо той самий формат ключа, що і в clients Map.
        const phone = normalizePhone(req.params.phone);
        const client = clients.get(phone);
        if (client && client.authInfo) {
            logger.log(`Сесія ${phone} активна`, LogLevels.Info, 'status');
            res.json({ status: 'connected', phone, isAuthenticated: true });
        } else {
            logger.log(`Сесія ${phone} не активна`, LogLevels.Warning, 'status');
            res.json({ status: 'disconnected', phone, isAuthenticated: false });
        }
    } catch (err) {
        logger.log(`Помилка в /status для ${req.params.phone}: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'status');
        res.status(500).json({ status: 'error', message: 'Внутрішня помилка сервера' });
    }
});

// Видалення сесії
app.delete('/sessiondelete/:phone', async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);
        const client = clients.get(phone);

        if (client) {
            await client.destroy().catch(err => logger.log(`Помилка при закритті сесії ${phone}: ${err.message}`, LogLevels.Error, 'sessiondelete'));
            clients.delete(phone);
            clearQrTimer(phone);
            setSessionHealth(phone, { healthy: false, hasUser: false, state: 'deleted' });
            await pushSessionHealthToServer('deleted');
            logger.log(`Сесія видалена: ${phone}`, LogLevels.Info, 'session');
        }

        removeSessionData(phone);

        res.json({ status: 'deleted', phone, message: 'Сесія успішно видалена' });
    } catch (err) {
        logger.log(`Помилка при видаленні сесії для ${req.params.phone}: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'sessiondelete');
        res.status(500).json({ status: 'error', message: 'Помилка при видаленні сесії' });
    }
});

// Endpoint для перевірки стану сесій (сумісно з index_old.js: [{ phone, status }]).
app.get('/whatsapp_health', (req, res) => {
    try {
        const result = buildSessionHealthSnapshot().map(({ phone, status }) => ({ phone, status }));
        logger.log(`Запит /whatsapp_health, кількість сесій: ${result.length}`, LogLevels.Info, 'health');
        res.json(result);
    } catch (err) {
        logger.log(`Помилка whatsapp_health: ${err.message}`, LogLevels.Error, 'health');
        res.status(500).json({
            status: 'error',
            message: 'Health-check failed'
        });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    logger.log(`WhatsApp Multi Session Server запущено на порті ${PORT}`, LogLevels.Info, 'server');
    // Періодична синхронізація стану сесій на зовнішній сервер (раз на 60 секунд).
    setInterval(() => {
        pushSessionHealthToServer('periodic').catch((err) => {
            logger.log(`Помилка periodic health push: ${err.message}`, LogLevels.Warning, 'healthPush');
        });
    }, 60000);
    await initializeRegisteredSessions().catch(err => {
        logger.log(`Помилка в initializeRegisteredSessions: ${err.message}. Продовжую роботу сервера.`, LogLevels.Error, 'server');
    });
});

// Обробка неочікуваних помилок
process.on('uncaughtException', (err) => {
    logger.log(`Неперехоплена помилка: ${err.message}\nStack: ${err.stack}. Продовжую роботу сервера.`, LogLevels.Error, 'uncaught');
    // Не завершуємо процес, а продовжуємо роботу
});

// Обробка обіцянок, які були відхилені
process.on('unhandledRejection', (reason, promise) => {
    // reason може бути не Error, тому безпечніше приводити до рядка.
    const reasonText = reason?.message || String(reason);
    logger.log(`Необроблена обіцянка: ${reasonText}\nPromise: ${promise}. Продовжую роботу сервера.`, LogLevels.Error, 'unhandledRejection');
});
