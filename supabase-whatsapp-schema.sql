-- ============================================================================
-- Phloton — WhatsApp agent (prototype): map a WhatsApp number to a user.
-- Run in the Supabase SQL Editor after supabase-auth-schema.sql.
-- Additive; does not touch existing data.
-- ============================================================================

-- Store the customer's WhatsApp number in E.164 (e.g. +919812345678).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Fast lookup when an inbound WhatsApp message arrives.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_phone
  ON public.profiles (phone)
  WHERE phone IS NOT NULL;

-- ============================================================================
-- Register YOUR WhatsApp number for testing (admin → sees all units).
-- Use full E.164 incl. country code, no spaces:
--
--   UPDATE public.profiles
--   SET phone = '+919812345678'
--   WHERE email = 'prerit@phloton.com';
-- ============================================================================
