-- ============================================================================
-- Phloton — chat-agent identity mapping (prototype).
-- Maps a WhatsApp number and/or Telegram user id to a Phloton user.
-- Run in the Supabase SQL Editor after supabase-auth-schema.sql.
-- Additive; does not touch existing data.
-- ============================================================================

-- WhatsApp number in E.164 (e.g. +919812345678); Telegram numeric user id.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone       TEXT,
  ADD COLUMN IF NOT EXISTS telegram_id TEXT;

-- Fast lookups when an inbound message arrives.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_phone
  ON public.profiles (phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_telegram
  ON public.profiles (telegram_id)
  WHERE telegram_id IS NOT NULL;

-- ============================================================================
-- Link YOUR accounts for testing (admin → sees all units).
--
-- Telegram: message the bot once; it replies with "Your Telegram ID: <N>".
--   UPDATE public.profiles SET telegram_id = '<N>'
--   WHERE email = 'prerit@phloton.com';
--
-- WhatsApp (when Twilio works): full E.164, no spaces.
--   UPDATE public.profiles SET phone = '+919812345678'
--   WHERE email = 'prerit@phloton.com';
-- ============================================================================
