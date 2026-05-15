/**
 * Server Supabase client (session-aware, cookie-backed).
 *
 * For Server Components, Route Handlers and Server Actions — reads the
 * user's session from request cookies so RLS applies. Used by the layout
 * to show the signed-in user and by the unit-page ownership guard.
 *
 * Next 14: cookies() is synchronous. Server Components cannot mutate
 * cookies, so setAll is wrapped in try/catch (the middleware refreshes
 * the session instead).
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createServerSupabase() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — cookie writes are handled
            // by the middleware. Safe to ignore.
          }
        },
      },
    }
  );
}
