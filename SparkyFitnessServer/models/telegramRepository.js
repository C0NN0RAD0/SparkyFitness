const { getSystemClient } = require('../db/poolManager');
const crypto = require('crypto');

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Creates a short-lived one-time link token for the given user.
 * Any unused previous tokens for the user are replaced.
 * @param {string} userId
 * @returns {{ token: string, expires_at: Date }}
 */
async function createLinkToken(userId) {
  const client = await getSystemClient();
  try {
    // 16 bytes = 128 bits of entropy — sufficient for a 15-minute single-use token.
    const token = crypto.randomBytes(16).toString('hex'); // 32-char hex
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

    // Replace any existing unused tokens for this user
    await client.query(
      'DELETE FROM public.telegram_link_tokens WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    );

    const result = await client.query(
      `INSERT INTO public.telegram_link_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING token, expires_at`,
      [userId, token, expiresAt],
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Verifies a link token (not expired, not already used) and marks it as used.
 * @param {string} token
 * @returns {string|null} The user_id the token belongs to, or null if invalid.
 */
async function verifyAndUseLinkToken(token) {
  const client = await getSystemClient();
  try {
    const result = await client.query(
      `UPDATE public.telegram_link_tokens
       SET used_at = NOW()
       WHERE token = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING user_id`,
      [token],
    );
    return result.rows[0]?.user_id ?? null;
  } finally {
    client.release();
  }
}

/**
 * Creates or updates the link between a SparkyFitness user and a Telegram chat.
 * @param {string} userId
 * @param {number} chatId
 * @param {string|null} username
 */
async function linkTelegramUser(userId, chatId, username) {
  const client = await getSystemClient();
  try {
    await client.query(
      `INSERT INTO public.telegram_user_links (user_id, telegram_chat_id, telegram_username)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET telegram_chat_id  = EXCLUDED.telegram_chat_id,
             telegram_username = EXCLUDED.telegram_username,
             linked_at         = NOW()`,
      [userId, chatId, username ?? null],
    );
  } finally {
    client.release();
  }
}

/**
 * Looks up the SparkyFitness user_id linked to the given Telegram chat_id.
 * Used by the bot to identify who is messaging it.
 * @param {number} chatId
 * @returns {string|null}
 */
async function getUserByTelegramChatId(chatId) {
  const client = await getSystemClient();
  try {
    const result = await client.query(
      'SELECT user_id FROM public.telegram_user_links WHERE telegram_chat_id = $1',
      [chatId],
    );
    return result.rows[0]?.user_id ?? null;
  } finally {
    client.release();
  }
}

/**
 * Returns the Telegram link record for a SparkyFitness user, or null if not linked.
 * @param {string} userId
 * @returns {{ telegram_chat_id: number, telegram_username: string|null, linked_at: Date }|null}
 */
async function getLinkByUserId(userId) {
  const client = await getSystemClient();
  try {
    const result = await client.query(
      `SELECT telegram_chat_id, telegram_username, linked_at
       FROM public.telegram_user_links
       WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

/**
 * Removes the Telegram link for a user.
 * @param {string} userId
 * @returns {boolean} true if a link was removed
 */
async function unlinkTelegramUser(userId) {
  const client = await getSystemClient();
  try {
    const result = await client.query(
      'DELETE FROM public.telegram_user_links WHERE user_id = $1',
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

module.exports = {
  createLinkToken,
  verifyAndUseLinkToken,
  linkTelegramUser,
  getUserByTelegramChatId,
  getLinkByUserId,
  unlinkTelegramUser,
};
