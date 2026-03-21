"use client";

import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";

function ResetPasswordInner() {
  const router = useRouter();
  const search = useSearchParams();
  const tokenFromUrl = useMemo(() => search.get("token") || "", [search]);

  const [token, setToken] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      await apiFetch<{ ok: true }>("/auth/reset-password", {
        method: "POST",
        json: { token, newPassword },
      });
      toast.success("Password reset success");
      router.push("/login");
    } catch (err: any) {
      toast.error(err?.message || "Reset failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Reset Password</h1>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium">Reset token</label>
            <input
              className="mt-1 w-full rounded-md border px-3 py-2 font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="text-sm font-medium">New password</label>
            <div className="mt-1 flex gap-2">
              <input
                className="w-full rounded-md border px-3 py-2"
                type={showPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Confirm password</label>
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <button
            className="w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Resetting…" : "Reset password"}
          </button>
        </form>

        <div className="mt-4 text-sm">
          <Link className="underline" href="/login">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
