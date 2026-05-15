"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

export default function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function signOut() {
    setLoading(true);
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3 text-sm text-navy-200">
      <span className="hidden max-w-[180px] truncate sm:inline" title={email}>
        {email}
      </span>
      <div className="h-6 w-px bg-navy-100" />
      <button
        onClick={signOut}
        disabled={loading}
        className="flex items-center gap-1.5 rounded-md bg-navy-50 px-3 py-1.5 font-medium text-navy-800 transition hover:bg-navy-100 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" />
        {loading ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
