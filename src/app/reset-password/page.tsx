"use client";

/**
 * Password recovery landing page.
 *
 * Supabase's email link redirects here with the recovery tokens in the
 * URL fragment (#access_token=…&refresh_token=…&type=recovery). The
 * browser supabase client parses that, establishes a recovery session,
 * and fires a PASSWORD_RECOVERY event. We then let the user set a new
 * password via supabase.auth.updateUser({ password }).
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

function ResetForm() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // A recovery session arrives either via the PASSWORD_RECOVERY event
  // (fragment just consumed) or as an already-established session (re-
  // open). Treat both as "ready to accept a new password".
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setDone(true);
    // Slight delay so the success state is visible, then go in.
    setTimeout(() => {
      router.replace("/");
      router.refresh();
    }, 800);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-500">
            <span className="text-xl font-bold text-white">P</span>
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-navy-800">Set a new password</h1>
            <p className="mt-1 text-sm text-navy-200">
              Choose a password and you’ll be signed in.
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-navy-100 bg-white p-6 shadow-sm"
        >
          {!ready && !done && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Verifying recovery link…
            </p>
          )}

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-sm font-medium text-navy-800"
            >
              New password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-200" />
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-navy-100 bg-navy-50 py-2.5 pl-9 pr-3 text-sm text-navy-800 outline-none transition focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="confirm"
              className="mb-1.5 block text-sm font-medium text-navy-800"
            >
              Confirm password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-200" />
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-navy-100 bg-navy-50 py-2.5 pl-9 pr-3 text-sm text-navy-800 outline-none transition focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100"
                placeholder="••••••••"
              />
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
          {done && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Password updated. Signing you in…
            </p>
          )}

          <button
            type="submit"
            disabled={loading || done || !ready}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-teal-600 active:scale-[0.99] disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Updating…" : "Set new password"}
          </button>

          <p className="text-center text-xs text-navy-200">
            Trouble?{" "}
            <a
              href="/login"
              className="text-teal-600 hover:underline"
            >
              Back to sign in
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
