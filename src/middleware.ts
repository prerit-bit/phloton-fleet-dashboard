/**
 * Auth middleware.
 *
 *  - Refreshes the Supabase session cookie on every request.
 *  - Redirects unauthenticated users to /login (preserving the target
 *    path) — except for public pages (/login, /reset-password).
 *  - Bounces already-authenticated users off /login (but NOT off
 *    /reset-password — a password-recovery session counts as
 *    authenticated and the user is meant to land there).
 *  - Forwards the request pathname downstream as `x-phloton-pathname`
 *    so the root layout can render the bare auth screens without app
 *    chrome.
 *
 * /api/* is excluded via the matcher so the Vercel cron (/api/sync,
 * protected by CRON_SECRET) is never redirected.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PUBLIC_PATHS = new Set<string>(["/login", "/reset-password"]);

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Forward pathname to server components (e.g. root layout).
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("x-phloton-pathname", pathname);

  let response = NextResponse.next({ request: { headers: reqHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request: { headers: reqHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.has(pathname);

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?redirect=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // Only bounce signed-in users away from /login — NOT /reset-password
  // (recovery session is authenticated; user must stay to set new password).
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on all paths except Next internals, static assets and /api/*.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
