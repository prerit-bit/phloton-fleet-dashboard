/**
 * Service-role Supabase client (server-only).
 *
 * Used exclusively by the Anedya → Supabase sync service. The service
 * role key BYPASSES Row Level Security, so the sync pipeline keeps
 * working unchanged after RLS is enforced.
 *
 * Session-aware client reads moved to:
 *  - src/lib/supabase/client.ts (browser, RLS-scoped to the signed-in user)
 *  - src/lib/supabase/server.ts (server components / route handlers)
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Server-side writes (sync) — uses service role key
export const supabaseAdmin = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

/**
 * Check if Supabase is configured for client-side reads.
 */
export function isSupabaseConfigured(): boolean {
  return !!(supabaseUrl && supabaseAnonKey);
}
