const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const telegramRepository = require('../models/telegramRepository');

/**
 * @swagger
 * /telegram/generate-link-token:
 *   post:
 *     summary: Generate a one-time token to link the authenticated user's Telegram account
 *     tags: [Telegram]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Link token and optional deep-link URL.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 expires_at:
 *                   type: string
 *                   format: date-time
 *                 deep_link:
 *                   type: string
 *                   nullable: true
 *       500:
 *         description: Server error.
 */
router.post('/generate-link-token', authenticate, async (req, res, next) => {
  try {
    const result = await telegramRepository.createLinkToken(req.userId);
    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=${result.token}`
      : null;
    res.json({
      token: result.token,
      expires_at: result.expires_at,
      deep_link: deepLink,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /telegram/status:
 *   get:
 *     summary: Get the Telegram link status for the authenticated user
 *     tags: [Telegram]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Telegram link status.
 *       500:
 *         description: Server error.
 */
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const link = await telegramRepository.getLinkByUserId(req.userId);
    res.json({
      linked: !!link,
      bot_configured: !!process.env.TELEGRAM_BOT_TOKEN,
      ...(link
        ? {
            telegram_username: link.telegram_username,
            linked_at: link.linked_at,
          }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /telegram/unlink:
 *   delete:
 *     summary: Remove the Telegram link for the authenticated user
 *     tags: [Telegram]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Unlinked successfully.
 *       404:
 *         description: No Telegram account linked.
 *       500:
 *         description: Server error.
 */
router.delete('/unlink', authenticate, async (req, res, next) => {
  try {
    const removed = await telegramRepository.unlinkTelegramUser(req.userId);
    if (!removed) {
      return res.status(404).json({ error: 'No Telegram account linked.' });
    }
    res.json({ message: 'Telegram account unlinked successfully.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
