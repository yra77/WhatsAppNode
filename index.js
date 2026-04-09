require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const { Logger, LogLevels } = require('./logger'); // файл логера

const app = express();
app.use(express.json());

// Конфігурація
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const AUTH_DIR = path.join(process.cwd(), 'auth_sessions');

// Визначення директорії
const BASE_DIR = process.cwd();

// Перевірка обов'язкових змінних
if (!process.env.BASE_URL) {
    Logger.log('BASE_URL не задано в .env. Використовую http://localhost:3000', LogLevels.Warning, 'Startup');
}

// Ініціалізація директорії сесій
fs.ensureDirSync(AUTH_DIR);

// Зберігання клієнтів та допоміжних структур
const clients = new Map();
const qrTimers = new Map();
const initializingPhones = new Map();
const sessionStatus = new Map();

// Централізована перевірка, чи можна виконувати retry для конкретного номера.
// Виносимо в окрему функцію, щоб не дублювати однакові умови в різних гілках reconnect.
function canRetrySession(phoneNumber) {
    return !!(phoneNumber && phoneNumber !== 'undefined');
}

// Планувальник повторної ініціалізації сесії.
// Коментар важливий: retry тепер не блокується відсутнім lineId, бо саме це часто заважає
// повторно згенерувати QR після connection close (наприклад, код 405).
function scheduleSessionRetry(phoneNumber, lineId, delayMs, reason) {
    if (!canRetrySession(phoneNumber)) return;

    Logger.log(
        `Плануємо повторне створення сесії для ${phoneNumber} через ${delayMs}мс. Причина: ${reason}`,
        LogLevels.Info,
        'Reconnect'
    );

    setTimeout(() => createSession(phoneNumber, lineId), delayMs);
}

// Функція нормалізації номера телефону для імен файлів
function normalizePhone(phone) {
    return phone.replace(/[^0-9]/g, '');
}

// Функція для безпечного видалення сесії
async function safelyDestroySession(phoneNumber) {
    const normalized = normalizePhone(phoneNumber);
    const sock = clients.get(phoneNumber);

    try {
        if (sock) {
            await sock.logout().catch(() => { });
            clients.delete(phoneNumber);
            Logger.log(`Сесію клієнта успішно завершено: ${phoneNumber}`, LogLevels.Info, 'DestroySession');
        }

        const sessionPath = path.join(AUTH_DIR, `session-${normalized}`);
        await fs.remove(sessionPath);
        Logger.log(`Директорію сесії видалено: ${sessionPath}`, LogLevels.Info, 'DestroySession');
    } catch (err) {
        Logger.log(`Помилка при видаленні сесії ${phoneNumber}: ${err.message}`, LogLevels.Error, 'DestroySession');
    }

    clearQrTimer(phoneNumber);
    initializingPhones.delete(phoneNumber);
}

// Очищення QR-таймера
function clearQrTimer(phoneNumber) {
    if (qrTimers.has(phoneNumber)) {
        clearTimeout(qrTimers.get(phoneNumber));
        qrTimers.delete(phoneNumber);
    }
}

// Допоміжний метод: будуємо коректний JID для відправки у WhatsApp.
// Коментар важливий, бо @lid часто ламає доставку для звичайних телефонних номерів.
async function resolveRecipientJid(sock, to) {
    const normalized = String(to).replace(/[^0-9]/g, '');
    if (!normalized) {
        throw new Error('Некоректний номер отримувача');
    }

    // Спочатку перевіряємо у WhatsApp наявність номера і беремо server із відповіді.
    try {
        const waResult = await sock.onWhatsApp(`${normalized}@s.whatsapp.net`);
        if (Array.isArray(waResult) && waResult[0]?.exists && waResult[0]?.jid) {
            return waResult[0].jid;
        }
    } catch (err) {
        Logger.log(`Не вдалося перевірити onWhatsApp для ${normalized}: ${err.message}`, LogLevels.Warning, 'SendMsg');
    }

    // Якщо перевірка недоступна, використовуємо стандартний персональний JID.
    return `${normalized}@s.whatsapp.net`;
}

// Основна функція створення/відновлення сесії
async function createSession(phoneNumber, lineId, res = null) {

    const normalized = normalizePhone(phoneNumber);
    const sessionDir = path.join(AUTH_DIR, `session-${normalized}`);

    try {
        Logger.log(`Починаємо створення сесії для ${phoneNumber}`, LogLevels.Info, 'CreateSession');

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            browser: ['Chrome', 'Windows', '10'],
            logger: require('pino')({ level: 'silent' })
        });

        clients.set(phoneNumber, sock);

        // Обробка оновлення стану з'єднання
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // додамо ліміт на кількість QR
                if (res && !res.headersSent) res.json({ status: 'qr', qr: await qrcode.toDataURL(qr) });
                Logger.log(`Згенеровано QR-код для ${phoneNumber}`, LogLevels.Info, 'QR');
                // зміна статусу сесії
                setSessionHealthy(phoneNumber, false);
                // Після генерації QR сесія не авторизована, тому hasUser = false.
                setSessionHasUser(phoneNumber, false);
                // Обмежуємо кількість спроб QR
                const attempts = (qrTimers.get(phoneNumber + '_attempts') || 0) + 1;
                qrTimers.set(phoneNumber + '_attempts', attempts);
                if (attempts > 5) {
                    Logger.log(`Перевищено ліміт спроб QR для ${phoneNumber} — зупиняємо`, LogLevels.Error, 'QR');
                    await safelyDestroySession(phoneNumber);
                    if (res) res.json({ status: 'error', message: 'Перевищено кількість спроб сканування QR' });
                    return;
                }
            }

            if (connection === 'open') {
                clearQrTimer(phoneNumber);
                qrTimers.delete(phoneNumber + '_attempts'); // скидаємо лічильник
                // зміна статусу сесії
                setSessionHealthy(phoneNumber, true);
                // Фіксуємо наявність user одразу після успішного відкриття сесії.
                setSessionHasUser(phoneNumber, !!sock.user);

                Logger.log(`Сесія успішно підключена: ${phoneNumber}`, LogLevels.Success, 'Connection');
                if (res && !res.headersSent) res.json({ status: 'success' });

                // Сповіщення ASP.NET
                await fetch(`${BASE_URL}/whatsapp?handler=NotifyAuthSuccess&phone=${encodeURIComponent(phoneNumber)}&lineId=${encodeURIComponent(lineId)}`).catch(() => { });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const disconnectMessage = lastDisconnect?.error?.message || 'no message';

                // зміна статусу сесії
                setSessionHealthy(phoneNumber, false);
                Logger.log(
                    `З'єднання розірвано для ${phoneNumber}. Код: ${statusCode}, причина: ${disconnectMessage}`,
                    LogLevels.Warning,
                    'Connection'
                );

                // Тимчасові коди Baileys: бібліотека зазвичай перепідключиться автоматично.
                if ([DisconnectReason.restartRequired, DisconnectReason.connectionClosed].includes(statusCode)) {
                    Logger.log(
                        `Baileys auto-reconnect для ${phoneNumber}, code ${statusCode}`,
                        LogLevels.Info,
                        'Reconnect'
                    );
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut) {
                    Logger.log(`Користувач вийшов з акаунту ${phoneNumber} → видаляємо сесію`, LogLevels.Important, 'Logout');
                    await safelyDestroySession(phoneNumber);
                    await fetch(`${BASE_URL}/whatsapp?handler=AuthError&phone=${encodeURIComponent(phoneNumber)}`).catch(() => { });
                    return;
                }

                // Код 405 трапляється при зламаному/несумісному auth-state. Примусово очищаємо сесію
                // і стартуємо нове QR-з'єднання, інакше сервіс застрягає в нескінченних "close 405".
                if (statusCode === 405) {
                    Logger.log(
                        `Код 405 для ${phoneNumber}: очищаємо auth-state і повторюємо реєстрацію`,
                        LogLevels.Important,
                        'Connection'
                    );
                    await safelyDestroySession(phoneNumber);

                    // Retry запускаємо навіть коли lineId тимчасово відсутній:
                    // для генерації QR критичний саме phoneNumber + чистий auth-state.
                    scheduleSessionRetry(phoneNumber, lineId, 5000, 'connection close 405');
                    return;
                }

                // Для інших помилок лишаємо звичний backoff перед наступною спробою.
                scheduleSessionRetry(phoneNumber, lineId, 30000, `connection close ${statusCode || 'unknown'}`);
            }
        });

        // Збереження оновлених credentials
        sock.ev.on('creds.update', (creds) => {
            // Якщо з'явився ідентифікатор користувача, позначаємо сесію як авторизовану.
            if (creds?.me?.id || sock?.user?.id) {
                setSessionHasUser(phoneNumber, true);
            }

            saveCreds();
        });

        // Обробка вхідних повідомлень
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                await handleMessageEventBaileys(msg, phoneNumber);
            }
        });

    } catch (err) {
        Logger.log(`Критична помилка при створенні сесії ${phoneNumber}: ${err.message}`, LogLevels.Error, 'CreateSession');
        if (res && !res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
}

// =============================================
// Метод відправки повідомлень
// =============================================
async function handleMessageEventBaileys(msg, phoneNumber) {
    try {
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.participant || msg.key.remoteJid;
        const from = senderJid.split('@')[0]; // WAID
        const to = phoneNumber;
        const messageId = msg.key.id;
        const timestamp = msg.messageTimestamp;

        const type = Object.keys(msg.message)[0];

        let messageText = '';
        let mediaData = null;

        // ===== TEXT =====
        if (type === 'conversation') {
            messageText = msg.message.conversation;
        }
        else if (type === 'extendedTextMessage') {
            messageText = msg.message.extendedTextMessage.text;
        }

        // ===== MEDIA =====
        else if (
            type === 'imageMessage' ||
            type === 'videoMessage' ||
            type === 'audioMessage' ||
            type === 'documentMessage' ||
            type === 'stickerMessage'
        ) {
            messageText = msg.message[type]?.caption || type;

            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { Logger }
                );

                const mimeType = msg.message[type].mimetype;
                const ext = mimeType?.split('/')[1] || 'bin';

                const sessionFolder = `whatsapp_${phoneNumber.replace(/\D/g, '')}`;
                const filesDirectory = path.join(BASE_DIR, sessionFolder, 'files');
                await fs.ensureDir(filesDirectory);

                const filename =
                    msg.message[type].fileName ||
                    `${type}_${messageId}.${ext}`;

                const filePath = path.join(filesDirectory, filename);

                await fs.writeFile(filePath, buffer);

                const fileSizeInMB = buffer.length / (1024 * 1024);
                if (fileSizeInMB > 100) {
                    messageText = 'занадто великий файл. не вдалося відправити';
                } else {
                    mediaData = {
                        id: messageId,
                        mimeType,
                        caption: msg.message[type].caption || '',
                        filename: filePath
                    };
                }
            } catch (mediaErr) {
                Logger.log(
                    `Помилка завантаження медіа ${messageId}: ${mediaErr.message}`,
                    LogLevels.Warning,
                    'Media'
                );
                messageText = `${type} (не вдалося завантажити)`;
            }
        }

        // ===== REACTION =====
        else if (type === 'reactionMessage') {
            messageText = `Реакція: ${msg.message.reactionMessage.text}`;
        }

        else {
            messageText = `Невідомий тип: ${type}`;
        }

        const normalizedType = normalizeType(type, msg);

        let payload = "";

        switch (normalizedType) {
            case 'image':
            case 'video':
            case 'audio':
            case 'document':
            case 'sticker':
                payload = {
                    entry: [{
                        changes: [{
                            value: {
                                messages: [{
                                    id: messageId,
                                    from: from,
                                    timestamp: timestamp,
                                    type: normalizedType,
                                    text: { body: messageText },
                                    [normalizedType]: mediaData
                                }],
                                metadata: {
                                    phone_number_id: phoneNumber
                                }
                            }
                        }]
                    }]
                };
                break;

            default:
                payload = {
                    entry: [{
                        changes: [{
                            value: {
                                messages: [{
                                    id: messageId,
                                    from: from,
                                    timestamp: timestamp,
                                    type: normalizedType,
                                    text: { body: messageText },
                                    media: mediaData
                                }],
                                metadata: {
                                    phone_number_id: phoneNumber
                                }
                            }
                        }]
                    }]
                };
                break;
        }

        Logger.log(
            `Отримано повідомлення від ${from}: ${messageText}`,
            LogLevels.Info,
            'handleMessageEvent'
        );

        const response = await fetch(`${process.env.BASE_URL}/whatsappwebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            Logger.log(
                `Помилка відправлення до ASP.NET: ${response.statusText}`,
                LogLevels.Warning,
                'handleMessageEvent'
            );
        } else {
            Logger.log(
                `Повідомлення відправлено до ASP.NET`,
                LogLevels.Success,
                'handleMessageEvent'
            );
        }

    } catch (err) {
        Logger.log(
            `Нештатна ситуація: ${err.message}`,
            LogLevels.Error,
            'handleMessageEvent'
        );
    }
}

// Нормалізуємо типи для ASP.NET
function normalizeType(type, msg) {
    switch (type) {
        case 'conversation':
        case 'extendedTextMessage':
            return 'text';

        case 'imageMessage':
            return 'image';

        case 'videoMessage':
            return 'video';

        case 'audioMessage':
            return msg.message.audioMessage?.ptt ? 'audio' : 'audio';

        case 'documentMessage':
            return 'document';

        case 'stickerMessage':
            return 'sticker';

        case 'reactionMessage':
            return 'reaction';

        default:
            return 'unknown';
    }
}


// =============================================
// Ендпоінти
// =============================================

// Реєстрація нового номера
app.post('/registerwhatsapp', async (req, res) => {
    try {
        const { phone, lineId } = req.body;
        if (!phone || !lineId) {
            return res.status(400).json({ status: 'error', message: 'Необхідні phone та lineId' });
        }

        await createSession(phone, lineId, res);
    } catch (err) {
        Logger.log(`Помилка в /registerwhatsapp: ${err.message}`, LogLevels.Error, 'API');
        res.status(500).json({ status: 'error', message: 'Внутрішня помилка сервера' });
    }
});

// Відправка повідомлення
app.post('/sendmsg', async (req, res) => {
    try {
        const { from, to, message, contentType = 'text', filePath, bitrixMessageId } = req.body;

        if (!from || !to || !message) {
            return res.status(400).json({ status: 'error', message: 'Необхідні from, to, message' });
        }

        const sock = clients.get(from);
        if (!sock) {
            return res.status(404).json({ status: 'error', message: 'Сесія не активна' });
        }

        // Раніше тут був жорстко зашитий @lid; тепер визначаємо коректний JID динамічно.
        const jid = await resolveRecipientJid(sock, to);
        let sentMessage;

        if (contentType === 'text') {
            sentMessage = await sock.sendMessage(jid, { text: message });
        } else if (filePath && await fs.pathExists(filePath)) {
            const buffer = await fs.readFile(filePath);
            const mime = require('mime-types').lookup(filePath) || 'application/octet-stream';
            const type = contentType === 'image' ? 'image' : 'document';
            sentMessage = await sock.sendMessage(jid, {
                [type]: buffer,
                mimetype: mime,
                caption: message
            });
        } else {
            return res.status(400).json({ status: 'error', message: 'Непідтримуваний тип або файл не знайдено' });
        }

        const messageId = sentMessage?.key?.id || require('crypto').randomBytes(8).toString('hex');

        res.json({
            status: 'sent',
            messageId,
            bitrixMessageId
        });

        Logger.log(`Повідомлення відправлено від ${from} до ${to}, id: ${messageId}`, LogLevels.Success, 'SendMsg');
    } catch (err) {
        Logger.log(`Помилка відправки повідомлення: ${err.message}`, LogLevels.Error, 'SendMsg');
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Видалення сесії
app.delete('/sessiondelete/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        await safelyDestroySession(phone);
        res.json({ status: 'deleted', message: 'Сесія успішно видалена' });
    } catch (err) {
        Logger.log(`Помилка видалення сесії ${req.params.phone}: ${err.message}`, LogLevels.Error, 'SessionDelete');
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Запуск сервера
app.listen(PORT, async () => {
    Logger.log(`WhatsApp сервер запущено на порту ${PORT}`, LogLevels.Important, 'Server');
    Logger.log(`BASE_URL: ${BASE_URL}`, LogLevels.Info, 'Server');

    setTimeout(() => {
        // Ініціалізація всіх зареєстрованих сесій при старті
        initRegisteredSessionsWithRetry(5, 30000);
    }, 30000);// Даємо ASP.NET час піднятись (додатково до BAT)
});

// Глобальний обробник неперехоплених помилок
process.on('uncaughtException', (err) => {
    Logger.log(`CRITICAL UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`, LogLevels.Error, 'Global');
    // Не завершуємо процес, щоб побачити помилку
});

process.on('unhandledRejection', (reason, promise) => {
    Logger.log(`UNHANDLED PROMISE REJECTION: ${reason}\nStack: ${reason?.stack || ''}`, LogLevels.Error, 'Global');
});

// 5 спроб інтервал 30 секунд, якщо ASP.NET ще не готовий, чекаємо
async function initRegisteredSessionsWithRetry(
    maxAttempts = 5,
    delayMs = 30000
) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            Logger.log(
                `Спроба ${attempt}/${maxAttempts}: отримання зареєстрованих номерів`,
                LogLevels.Info,
                'Startup'
            );

            const response = await fetch(`${BASE_URL}/whatsapp?handler=RegisteredPhones`);

            if (response.status === 204) {
                Logger.log(
                    'Зареєстрованих номерів немає (204)',
                    LogLevels.Info,
                    'Startup'
                );
                return;
            }

            if (!response.ok) {
                throw new Error(`Unexpected status: ${response.status}`);
            }

            const data = await response.json();
            Logger.log(
                `Отримано ${data.length} зареєстрованих номерів`,
                LogLevels.Success,
                'Startup'
            );

            for (const { phoneNumber, lineId } of data) {
                await createSession(phoneNumber, lineId);
            }

            return; // якщо успіх — виходимо

        } catch (err) {
            Logger.log(
                `Спроба ${attempt} не вдалася: ${err.message}`,
                LogLevels.Warning,
                'Startup'
            );

            if (attempt < maxAttempts) {
                Logger.log(
                    `Очікуємо ${delayMs / 1000} сек перед повторною спробою...`,
                    LogLevels.Info,
                    'Startup'
                );
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }

    Logger.log(
        '❌ Не вдалося ініціалізувати сесії після всіх спроб',
        LogLevels.Error,
        'Startup'
    );
}

// Оновлення статусу
function setSessionHealthy(phone, isHealthy) {
    // Важливо: не скидаємо hasUser в false автоматично, щоб health-check не ламався
    // під час тимчасових reconnection-подій, коли сокет ще не встиг оновити user.
    const previous = sessionStatus.get(phone) || {};

    sessionStatus.set(phone, {
        healthy: !!isHealthy,
        lastUpdate: Date.now(),
        hasUser: previous.hasUser === true
    });
}

// Централізовано позначаємо, що у сесії є валідний авторизований користувач.
// Окремий метод спрощує підтримку і запобігає розсинхронізації поля hasUser.
function setSessionHasUser(phone, hasUser) {
    const previous = sessionStatus.get(phone) || {};

    sessionStatus.set(phone, {
        healthy: previous.healthy === true,
        lastUpdate: Date.now(),
        hasUser: !!hasUser
    });
}

// Endpoint для перевірки стану сесій
// повертає масив: [ { "phone": "+380...", "status": 1 } ]
app.get('/whatsapp_health', (req, res) => {
    try {
        const result = [];

        for (const [phone, sock] of clients.entries()) {

            // визначаємо, чи сесія жива
            const healthy =
                sessionStatus.get(phone)?.healthy === true &&
                // Дозволяємо healthy, якщо user вже є в sock або зафіксований у статусі.
                (sessionStatus.get(phone)?.hasUser === true || !!sock?.user);

            Logger.log(`${phone} Сесія - ${healthy}`, LogLevels.Info, 'Health');

            result.push({
                phone,
                status: healthy ? 1 : 0
                // або: status: healthy
            });
        }

        res.json(result);

    } catch (err) {
        Logger.log(
            `Помилка whatsapp_health: ${err.message}`,
            LogLevels.Error,
            'Health'
        );

        res.status(500).json({
            status: 'error',
            message: 'Health-check failed'
        });
    }
});
