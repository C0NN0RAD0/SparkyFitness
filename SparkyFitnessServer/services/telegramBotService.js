/**
 * Telegram Bot Integration for SparkyFitness
 *
 * Routes Telegram messages through the existing chatService AI pipeline so users
 * can interact with Sparky directly from Telegram without changing the core project.
 *
 * Configuration (via environment variables):
 *   TELEGRAM_BOT_TOKEN    — required; BotFather token (disables the bot if not set)
 *   TELEGRAM_BOT_USERNAME — optional; used to build clickable deep-link URLs
 *
 * Linking flow:
 *   1. User clicks "Generate Link Token" in Settings → integrations → Telegram.
 *   2. They open Telegram and send /start <token> to the bot.
 *   3. The bot verifies the token, stores the Telegram chat ID → user ID mapping.
 *   4. All subsequent messages are routed through chatService.processChatMessage().
 *
 * Barcode features:
 *   - Typing 8–14 digits triggers an automatic barcode lookup.
 *   - /barcode <number> is an explicit barcode lookup command.
 *   - Sending a photo attempts AI-powered barcode extraction first,
 *     then falls back to nutrition-label scanning.
 */

const { log } = require('../config/logging');
const telegramRepository = require('../models/telegramRepository');
const chatService = require('./chatService');
const { lookupBarcode } = require('./foodCoreService');
const { extractNutritionFromLabel } = require('./labelScanService');
const chatRepository = require('../models/chatRepository');
const { getDefaultVisionModel } = require('../ai/config');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_FILE_API = 'https://api.telegram.org/file/bot';

// Telegram's hard message length limit is 4096 characters.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_SAFE_MESSAGE_LENGTH = 4000; // leave room for the ellipsis

// Matches a raw barcode number typed as a plain text message.
// Covers EAN-8 (8), UPC-E (6→8), UPC-A (12), EAN-13 (13), ISBN-13 (13), and ITF-14 (14).
const BARCODE_PATTERN = /^\d{8,14}$/;

// Default timeout for Ollama image requests (vision can be slow on local hardware).
const DEFAULT_OLLAMA_TIMEOUT_MS = 60000;

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

// ─── Telegram file download ───────────────────────────────────────────────────

/**
 * Downloads a file from Telegram and returns it as a base64 string.
 * @param {string} token - Bot token
 * @param {string} fileId - Telegram file_id
 * @returns {{ base64: string, mimeType: string }|null}
 */
async function downloadTelegramFile(token, fileId) {
  try {
    const fileRes = await callApi(token, 'getFile', { file_id: fileId });
    if (!fileRes.ok || !fileRes.result?.file_path) return null;
    const downloadUrl = `${TELEGRAM_FILE_API}${token}/${fileRes.result.file_path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    // Telegram photos are always JPEG; documents preserve their extension.
    const filePath = fileRes.result.file_path;
    let mimeType = 'image/jpeg';
    if (filePath.endsWith('.png')) mimeType = 'image/png';
    else if (filePath.endsWith('.webp')) mimeType = 'image/webp';
    return { base64, mimeType };
  } catch (err) {
    log('error', '[TelegramBot] File download failed:', err);
    return null;
  }
}

// ─── Barcode helpers ──────────────────────────────────────────────────────────

/**
 * Uses the user's configured AI vision service to try to extract a barcode number
 * from an image. Returns the numeric barcode string, or null if none found.
 * @param {string} base64
 * @param {string} mimeType
 * @param {string} aiServiceId
 * @param {string} userId
 * @returns {string|null}
 */
async function extractBarcodeFromImage(base64, mimeType, aiServiceId, userId) {
  try {
    const aiService = await chatRepository.getAiServiceSettingForBackend(aiServiceId, userId);
    if (!aiService) return null;
    if (aiService.service_type !== 'ollama' && !aiService.api_key) return null;

    const model = aiService.model_name || getDefaultVisionModel(aiService.service_type);
    const apiKey = aiService.api_key;

    const prompt =
      'Look at this image. If it contains a barcode (1D barcode, QR code, or EAN/UPC label), ' +
      'return ONLY the barcode digits as a plain number with no spaces or other text. ' +
      'If there is no barcode visible, return exactly the word NONE.';

    let response;
    switch (aiService.service_type) {
      case 'google':
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { inline_data: { mime_type: mimeType, data: base64 } },
                    { text: prompt },
                  ],
                  role: 'user',
                },
              ],
            }),
          },
        );
        break;
      case 'anthropic':
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: 64,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
                  { type: 'text', text: prompt },
                ],
              },
            ],
          }),
        });
        break;
      case 'ollama': {
        const { Agent } = require('undici');
        const timeout = aiService.timeout || DEFAULT_OLLAMA_TIMEOUT_MS;
        const ollamaAgent = new Agent({ headersTimeout: timeout, bodyTimeout: timeout });
        try {
          response = await fetch(`${aiService.custom_url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt, images: [base64] }],
              stream: false,
            }),
            dispatcher: ollamaAgent,
          });
        } finally {
          ollamaAgent.destroy();
        }
        break;
      }
      default: {
        // OpenAI-compatible format (openai, openai_compatible, mistral, groq, openrouter, custom)
        const urlMap = {
          openai: 'https://api.openai.com/v1/chat/completions',
          mistral: 'https://api.mistral.ai/v1/chat/completions',
          groq: 'https://api.groq.com/openai/v1/chat/completions',
          openrouter: 'https://openrouter.ai/api/v1/chat/completions',
        };
        const url = urlMap[aiService.service_type]
          || (aiService.custom_url ? `${aiService.custom_url}/chat/completions` : null);
        if (!url) return null;
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 64,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                  { type: 'text', text: prompt },
                ],
              },
            ],
          }),
        });
      }
    }

    if (!response || !response.ok) return null;
    const data = await response.json();

    let raw;
    switch (aiService.service_type) {
      case 'google': raw = data.candidates?.[0]?.content?.parts?.[0]?.text; break;
      case 'anthropic': raw = data.content?.[0]?.text; break;
      case 'ollama': raw = data.message?.content; break;
      default: raw = data.choices?.[0]?.message?.content;
    }

    if (!raw) return null;
    const cleaned = raw.trim();
    if (cleaned.toUpperCase() === 'NONE' || !/\d/.test(cleaned)) return null;
    // Extract only the digits in case the model added extra text
    const digits = cleaned.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  } catch (err) {
    log('warn', '[TelegramBot] Barcode extraction from image failed:', err);
    return null;
  }
}

/**
 * Formats a food lookup result into a human-readable Telegram message.
 * @param {{ source: string, food: object|null }} result
 * @param {string} barcode
 * @returns {string}
 */
function formatFoodResult(result, barcode) {
  if (!result.food) {
    return (
      `❌ *No food found for barcode \`${barcode}\`*\n\n` +
      'The barcode was not found in the local database or any configured external provider.\n\n' +
      '_Tip: Make sure you have a barcode provider (OpenFoodFacts, USDA, FatSecret) configured in SparkyFitness → Settings._'
    );
  }

  const food = result.food;
  const variant = food.default_variant;
  const sourceLabel = {
    local: '📦 Local database',
    openfoodfacts: '🌍 OpenFoodFacts',
    fatsecret: '🥗 FatSecret',
    usda: '🏛 USDA',
  }[result.source] || result.source;

  let msg = `🔍 *${food.name || 'Unknown food'}*`;
  if (food.brand) msg += ` — ${food.brand}`;
  msg += `\n_Source: ${sourceLabel}_\n`;

  if (variant) {
    const serving = variant.serving_size
      ? `${variant.serving_size}${variant.serving_unit ? ' ' + variant.serving_unit : ''}`
      : null;
    if (serving) msg += `\n📏 Serving: *${serving}*`;
    if (variant.calories !== null) msg += `\n🔥 Calories: *${variant.calories} kcal*`;

    const macros = [];
    if (variant.protein !== null) macros.push(`Protein: *${variant.protein}g*`);
    if (variant.carbs !== null) macros.push(`Carbs: *${variant.carbs}g*`);
    if (variant.fat !== null) macros.push(`Fat: *${variant.fat}g*`);
    if (macros.length) msg += '\n' + macros.join('  •  ');

    const extras = [];
    if (variant.dietary_fiber !== null) extras.push(`Fibre: ${variant.dietary_fiber}g`);
    if (variant.sugars !== null) extras.push(`Sugars: ${variant.sugars}g`);
    if (variant.sodium !== null) extras.push(`Sodium: ${variant.sodium}mg`);
    if (extras.length) msg += '\n_' + extras.join('  •  ') + '_';
  }

  msg += '\n\n💬 _Say "log this for breakfast" (or lunch, dinner, snack) to log it._';
  return msg;
}

/**
 * Runs a barcode lookup and sends the result to the Telegram chat.
 * Also injects a summary into the conversation history so the AI has context
 * when the user follows up with "log this".
 * @param {string} token
 * @param {number} chatId
 * @param {string} barcode
 * @param {string} userId
 * @param {string} activeSettingId
 */
async function performBarcodeLookup(token, chatId, barcode, userId) {
  await sendTyping(token, chatId);
  try {
    const result = await lookupBarcode(barcode, userId);
    const reply = formatFoodResult(result, barcode);
    await sendMessage(token, chatId, reply);

    if (result.food) {
      // Inject a synthetic user message into the conversation history so the AI has
      // context when the user follows up with "log this for dinner" etc.
      const food = result.food;
      const variant = food.default_variant;
      const summary = [
        `[Barcode scan result for barcode ${barcode}]`,
        `Food: ${food.name || 'Unknown'}${food.brand ? ' by ' + food.brand : ''}`,
        variant?.calories !== null ? `Calories: ${variant.calories} kcal` : null,
        variant?.protein !== null ? `Protein: ${variant.protein}g` : null,
        variant?.carbs !== null ? `Carbs: ${variant.carbs}g` : null,
        variant?.fat !== null ? `Fat: ${variant.fat}g` : null,
      ]
        .filter(Boolean)
        .join(', ');
      addToHistory(chatId, 'user', summary);
    }
  } catch (err) {
    log('error', `[TelegramBot] Barcode lookup failed for ${barcode}:`, err);
    await sendMessage(
      token,
      chatId,
      '❌ Sorry, the barcode lookup failed. Please try again.',
    );
  }
}

/**
 * Handles a photo message: tries AI barcode extraction, then nutrition label scanning.
 * @param {string} token
 * @param {object} message - Telegram message object
 * @param {number} chatId
 * @param {string} userId
 * @param {{ id: string }} activeSetting
 */
async function handlePhotoMessage(token, message, chatId, userId, activeSetting) {
  await sendTyping(token, chatId);

  // Use the largest available photo (last in the array)
  const photos = message.photo;
  const largest = photos[photos.length - 1];
  const fileData = await downloadTelegramFile(token, largest.file_id);

  if (!fileData) {
    await sendMessage(
      token,
      chatId,
      '❌ Could not download the photo. Please try again.',
    );
    return;
  }

  // Step 1: Try to extract a barcode from the image using AI vision
  await sendTyping(token, chatId);
  const barcodeNumber = await extractBarcodeFromImage(
    fileData.base64,
    fileData.mimeType,
    activeSetting.id,
    userId,
  );

  if (barcodeNumber) {
    await sendMessage(
      token,
      chatId,
      `📷 Barcode detected: \`${barcodeNumber}\` — looking it up…`,
    );
    await performBarcodeLookup(token, chatId, barcodeNumber, userId);
    return;
  }

  // Step 2: No barcode found — try nutrition label scanning
  await sendTyping(token, chatId);
  const labelResult = await extractNutritionFromLabel(
    fileData.base64,
    fileData.mimeType,
    userId,
  );

  if (labelResult.success && labelResult.nutrition) {
    const n = labelResult.nutrition;
    let msg = '🏷 *Nutrition label scanned!*\n';
    if (n.name) msg += `\n*${n.name}*${n.brand ? ' — ' + n.brand : ''}`;
    const serving = n.serving_size ? `${n.serving_size}${n.serving_unit ? ' ' + n.serving_unit : ''}` : null;
    if (serving) msg += `\n📏 Serving: *${serving}*`;
    if (n.calories !== null) msg += `\n🔥 Calories: *${n.calories} kcal*`;
    const macros = [];
    if (n.protein !== null) macros.push(`Protein: *${n.protein}g*`);
    if (n.carbs !== null) macros.push(`Carbs: *${n.carbs}g*`);
    if (n.fat !== null) macros.push(`Fat: *${n.fat}g*`);
    if (macros.length) msg += '\n' + macros.join('  •  ');
    const extras = [];
    if (n.fiber !== null) extras.push(`Fibre: ${n.fiber}g`);
    if (n.sugars !== null) extras.push(`Sugars: ${n.sugars}g`);
    if (n.sodium !== null) extras.push(`Sodium: ${n.sodium}mg`);
    if (extras.length) msg += '\n_' + extras.join('  •  ') + '_';
    msg += '\n\n💬 _Say "log this for breakfast" (or lunch, dinner, snack) to log it._';

    await sendMessage(token, chatId, msg);

    // Inject into history for follow-up logging
    const summary = [
      '[Nutrition label scan result]',
      n.name ? `Food: ${n.name}${n.brand ? ' by ' + n.brand : ''}` : null,
      serving ? `Serving: ${serving}` : null,
      n.calories !== null ? `Calories: ${n.calories} kcal` : null,
      n.protein !== null ? `Protein: ${n.protein}g` : null,
      n.carbs !== null ? `Carbs: ${n.carbs}g` : null,
      n.fat !== null ? `Fat: ${n.fat}g` : null,
    ]
      .filter(Boolean)
      .join(', ');
    addToHistory(chatId, 'user', summary);
    const messages = getHistory(chatId);
    try {
      const { content } = await chatService.processChatMessage(messages, activeSetting.id, userId);
      addToHistory(chatId, 'assistant', content);
    } catch {
      // Non-fatal — history injection failed but user saw the label data
    }
    return;
  }

  // Step 3: Neither a barcode nor a label — ask user to describe in text
  await sendMessage(
    token,
    chatId,
    '📷 I couldn\'t detect a barcode or read a nutrition label from this image.\n\n' +
      '*Try one of these instead:*\n' +
      '• Type or paste the barcode number directly (8–14 digits)\n' +
      '• Use /barcode 1234567890123\n' +
      '• Describe the food in text: _"I had a bowl of oat porridge"_',
  );
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

  const chatId = message.chat.id;

  // ── Photo messages ───────────────────────────────────────────────────────
  if (message.photo) {
    const userId = await telegramRepository.getUserByTelegramChatId(chatId);
    if (!userId) {
      await sendMessage(
        token,
        chatId,
        '⚠️ Your account is not linked yet.\n\n' +
          'Go to *SparkyFitness → Settings → Telegram Integration* to link your account.',
      );
      return;
    }
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
    await handlePhotoMessage(token, message, chatId, userId, activeSetting);
    return;
  }

  if (!message.text) return;

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
        '*Barcode scanning*\n' +
        '• 📷 Send a photo of a barcode to look up the product\n' +
        '• 📷 Send a photo of a nutrition label to extract its data\n' +
        '• Type the barcode number: _5010013002086_\n' +
        '• /barcode 5010013002086 — explicit barcode lookup\n\n' +
        '*Commands*\n' +
        '• /help — Show this message\n' +
        '• /status — Check your link status\n' +
        '• /barcode <number> — Look up a product by barcode\n\n' +
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

  // ── /barcode <number> ────────────────────────────────────────────────────
  if (text.startsWith('/barcode')) {
    const parts = text.split(/\s+/);
    const barcode = parts[1]?.replace(/\D/g, '');
    if (!barcode || barcode.length < 8 || barcode.length > 14) {
      await sendMessage(
        token,
        chatId,
        '❌ Please provide a valid barcode number (8–14 digits).\n\nExample: `/barcode 5010013002086`',
      );
      return;
    }
    await performBarcodeLookup(token, chatId, barcode, userId);
    return;
  }

  // ── Bare barcode (8–14 digits typed as a message) ────────────────────────
  if (BARCODE_PATTERN.test(text)) {
    await performBarcodeLookup(token, chatId, text, userId);
    return;
  }

  // ── Regular AI chat ──────────────────────────────────────────────────────

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
