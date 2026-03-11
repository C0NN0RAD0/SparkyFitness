-- Migration: Telegram Bot Integration
-- Adds tables for linking Telegram accounts to SparkyFitness users
-- and for managing one-time link tokens.

BEGIN;

-- Stores short-lived one-time tokens used to link a Telegram account.
-- A user generates a token from the Settings page, then sends it to the
-- Telegram bot via /start <token>.
-- ON DELETE CASCADE: tokens are automatically purged when the parent user is deleted.
CREATE TABLE IF NOT EXISTS public.telegram_link_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at    TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_token
    ON public.telegram_link_tokens (token);
CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_id
    ON public.telegram_link_tokens (user_id);

-- Stores the persistent mapping between a Telegram chat ID and a
-- SparkyFitness user account.
-- ON DELETE CASCADE: the link is automatically removed when the user is deleted.
CREATE TABLE IF NOT EXISTS public.telegram_user_links (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    telegram_chat_id  BIGINT NOT NULL UNIQUE,
    telegram_username TEXT,
    linked_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_links_chat_id
    ON public.telegram_user_links (telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_telegram_user_links_user_id
    ON public.telegram_user_links (user_id);

COMMIT;
