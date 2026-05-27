import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { createServerSupabase } from "@/lib/supabase/server";
import UserMenu from "@/components/UserMenu";

// Pages that should render bare (no app chrome) regardless of session
// — login + password-recovery (a recovery session is authenticated but
// the user must stay on /reset-password to set a new password).
const BARE_PATHS = new Set<string>(["/login", "/reset-password"]);

export const metadata: Metadata = {
  title: "Phloton Dashboard",
  description: "AI-powered cold chain device monitoring by Enhanced Innovations",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = headers().get("x-phloton-pathname") ?? "";
  const showChrome = !!user && !BARE_PATHS.has(pathname);

  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
      </head>
      <body className="min-h-screen bg-navy-50 antialiased">
        {showChrome ? (
          <>
            {/* Top nav (signed-in) */}
            <nav className="sticky top-0 z-50 border-b border-navy-100 bg-white/80 backdrop-blur-md">
              <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
                <a href="/" className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500">
                    <span className="text-sm font-bold text-white">P</span>
                  </div>
                  <span className="text-lg font-bold text-navy-800">
                    Phloton{" "}
                    <span className="font-normal text-navy-200">Dashboard</span>
                  </span>
                </a>
                <UserMenu email={user?.email ?? ""} />
              </div>
            </nav>
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
              {children}
            </main>
          </>
        ) : (
          // Unauthenticated (e.g. /login) — render bare, no app chrome.
          children
        )}
      </body>
    </html>
  );
}
