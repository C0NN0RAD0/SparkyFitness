/**
 * Telegram Bot Integration for SparkyFitness
 *
 * Routes Telegram messages through the existing chatService AI pipeline so users
 * can interact with Sparky directly from Telegram without changing the core project.
 *
 * Configuration (via environment variables):
 *   TELEGRAM_BOT_TOKEN   — required; BotFather token (disables the bot if not set)
 *   TELEGRAM_BOT_USERNAME — optional; used to build clickable deep-link URLs
 *
 * Linking flow:
 *   1. User clicks "Generate Link Token" in Settings → integrations → Telegram.
 *   2. They open Telegram and send /start <token> to the bot.
 *   3. The bot verifies the token, stores the Telegram chat ID → user ID mapping.
 *   4. All subsequent messages are routed through chatService.processChatMessage().
 */

const { log } = require('../config/logging');
const telegramRepository = require('../models/telegramRepository');
const chatService = require('./chatService');

const TELEGRAM_API = 'https://api.telegram.org/bot';

// Telegram's hard message length limit is 4096 characters.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_SAFE_MESSAGE_LENGTH = 4000; // leave room for the ellipsis

// Per-chat in-memory conversation history (last N messages kept for AI context).
const chatHistories = new Map();
const MAX_HISTORY_MESSAGES = 20;

// ─── Telegram HTTP helpers ────────────────────────────────────────────────────

function apiUrl(token, method) {
  return `${TELEGRAM_API}${token}/${method}`;
}

async function callApi(token, method, body = {}) {
  try {
    const res = await fetch(apiUrl(token, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (err) {
    log('error', `[TelegramBot] API call ${method} failed:`, err);
    return { ok: false };
  }
}

async function sendMessage(token, chatId, text) {
  // Telegram message limit; truncate gracefully.
  const safeText =
    text.length > TELEGRAM_SAFE_MESSAGE_LENGTH
      ? text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 3) + '…'
      : text;
  return callApi(token, 'sendMessage', {
    chat_id: chatId,
    text: safeText,
    parse_mode: 'Markdown',
  });
}

async function sendTyping(token, chatId) {
  return callApi(token, 'sendChatAction', {
    chat_id: chatId,
    action: 'typing',
  });
}

// ─── Conversation history helpers ────────────────────────────────────────────

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  return chatHistories.get(chatId);
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

// ─── AI response formatting ───────────────────────────────────────────────────

/**
 * The AI returns a JSON string like:
 *   {"intent":"log_food","data":{...},"response":"Logged your meal!"}
 * We show only the "response" field to the Telegram user.
 */
function extractResponse(rawContent) {
  try {
    const parsed = JSON.parse(rawContent);
    return parsed.response ?? rawContent;
  } catch {
    return rawContent;
  }
}

// ─── Update handlers ─────────────────────────────────────────────────────────

async function handleUpdate(token, update) {
  const message = update.message ?? update.edited_message;
  if (!message) return;

  // Only handle text messages for now
  if (!message.text) {
    if (message.photo) {
      await sendMessage(
        token,
        message.chat.id,
        '📷 Photo received! Please *describe* your food in text so I can log it accurately.\n\nExample: _"I had a plate of spaghetti bolognese, roughly 400g"_',
      );
    }
    return;
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const username = message.from?.username ?? null;

  // ── /start [token] ──────────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    if (parts.length >= 2) {
      const linkToken = parts[1];
      const userId = await telegramRepository.verifyAndUseLinkToken(linkToken);
      if (!userId) {
        await sendMessage(
          token,
          chatId,
          '❌ This link has expired or has already been used.\n\nPlease generate a new one from *SparkyFitness → Settings → Telegram Integration*.',
        );
        return;
      }
      await telegramRepository.linkTelegramUser(userId, chatId, username);
      chatHistories.delete(chatId); // Start a fresh conversation
      await sendMessage(
        token,
        chatId,
        '✅ *Your Telegram account is now linked to SparkyFitness!*\n\n' +
          'You can now chat with Sparky here. Try:\n' +
          '• _"Log 2 scrambled eggs and toast for breakfast"_\n' +
          '• _"I just went for a 30 minute run"_\n' +
          '• _"How many calories have I had today?"_\n\n' +
          'Type /help for more commands.',
      );
      return;
    }
    // /start with no token
    await sendMessage(
      token,
      chatId,
      '👋 *Welcome to the SparkyFitness bot!*\n\n' +
        'To link your account, go to *SparkyFitness → Settings → Telegram Integration* and tap *Generate Link Token*. ' +
        "Then come back here and tap the link you'll receive.",
    );
    return;
  }

  // ── /help ────────────────────────────────────────────────────────────────
  if (text === '/help') {
    await sendMessage(
      token,
      chatId,
      '🤖 *Sparky Fitness Bot*\n\n' +
        '*Logging food*\n' +
        '• "Log 2 eggs and toast for breakfast"\n' +
        '• "I had a chicken salad for lunch"\n\n' +
        '*Logging exercise*\n' +
        '• "I went for a 5km run"\n' +
        '• "30 minutes of yoga"\n\n' +
        '*Logging water*\n' +
        '• "Drank 3 glasses of water"\n\n' +
        '*Questions*\n' +
        '• "How many calories have I had today?"\n' +
        '• "What should I have for lunch?"\n\n' +
        '*Commands*\n' +
        '• /help — Show this message\n' +
        '• /status — Check your link status\n\n' +
        '_Tip: Sparky has full AI context — just talk naturally!_',
    );
    return;
  }

  // ── /status ──────────────────────────────────────────────────────────────
  if (text === '/status') {
    const userId = await telegramRepository.getUserByTelegramChatId(chatId);
    if (userId) {
      await sendMessage(token, chatId, '✅ Your account is linked to SparkyFitness.');
    } else {
      await sendMessage(
        token,
        chatId,
        '⚠️ Your Telegram account is *not linked* to a SparkyFitness account.\n\n' +
          'Go to *SparkyFitness → Settings → Telegram Integration* to link it.',
      );
    }
    return;
  }

  // ── Regular messages — require a linked account ──────────────────────────
  const userId = await telegramRepository.getUserByTelegramChatId(chatId);
  if (!userId) {
    await sendMessage(
      token,
      chatId,
      '⚠️ Your account is not linked yet.\n\n' +
        'Go to *SparkyFitness → Settings → Telegram Integration* to link your account, ' +
        'then come back here.',
    );
    return;
  }

  // Get the user's active AI service configuration
  const activeSetting = await chatService.getActiveAiServiceSetting(userId, userId);
  if (!activeSetting) {
    await sendMessage(
      token,
      chatId,
      '⚠️ No active AI service is configured for your account.\n\n' +
        'Please set one up in *SparkyFitness → Settings → AI Service*.',
    );
    return;
  }

  // Show typing indicator while waiting for the AI
  await sendTyping(token, chatId);

  // Add the user's message to conversation history, then send to AI
  addToHistory(chatId, 'user', text);
  const messages = getHistory(chatId);

  try {
    const { content } = await chatService.processChatMessage(
      messages,
      activeSetting.id,
      userId,
    );
    // Keep full AI JSON in history so the AI retains intent context
    addToHistory(chatId, 'assistant', content);

    const reply = extractResponse(content);
    await sendMessage(token, chatId, reply);
  } catch (err) {
    log('error', `[TelegramBot] processChatMessage failed for chat ${chatId}:`, err);
    // Remove the last user message so it doesn't poison future context
    const history = getHistory(chatId);
    if (history.length && history[history.length - 1].role === 'user') {
      history.pop();
    }
    await sendMessage(
      token,
      chatId,
      '❌ Sorry, I encountered an error processing your message. Please try again.',
    );
  }
}

// ─── Long-polling loop ────────────────────────────────────────────────────────

let pollingActive = false;

async function startPolling(token) {
  pollingActive = true;
  let offset = 0;
  let backoffMs = 1000; // Start with 1 second; doubles on each error up to 60 seconds.
  const MAX_BACKOFF_MS = 60000;
  log('info', '[TelegramBot] Long-polling started.');

  while (pollingActive) {
    try {
      const res = await fetch(
        `${TELEGRAM_API}${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=message,edited_message`,
      );
      if (!res.ok) {
        log('warn', `[TelegramBot] getUpdates returned HTTP ${res.status}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }
      const data = await res.json();
      if (!data.ok) {
        log('warn', '[TelegramBot] getUpdates API error:', data.description);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }
      // Successful response — reset backoff
      backoffMs = 1000;
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(token, update).catch((err) =>
          log('error', '[TelegramBot] Update handler error:', err),
        );
      }
    } catch (err) {
      if (pollingActive) {
        log('error', '[TelegramBot] Polling error:', err);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }
  log('info', '[TelegramBot] Long-polling stopped.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Telegram bot if TELEGRAM_BOT_TOKEN is configured.
 * Called once after migrations complete.
 */
function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log('info', '[TelegramBot] TELEGRAM_BOT_TOKEN not set — bot disabled.');
    return;
  }
  log('info', '[TelegramBot] Telegram bot integration enabled.');
  // Run polling in background; errors are logged but do not crash the server.
  startPolling(token).catch((err) =>
    log('error', '[TelegramBot] Fatal polling error:', err),
  );
}

function stop() {
  pollingActive = false;
}

module.exports = { start, stop };
