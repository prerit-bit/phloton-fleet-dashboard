/**
 * Browser Supabase client (session-aware).
 *
 * Uses @supabase/ssr so the logged-in user's session is read from cookies
 * and attached to every query. This is what makes Row Level Security
 * (owns_unit) actually scope data to the signed-in customer.
 *
 * Client-only: imported exclusively from "use client" components / the
 * client-side data layer (supabase-data.ts).
 */

import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
