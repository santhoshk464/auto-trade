"use client";

import Link from "next/link";
import { useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResetToken(null);
    try {
      const res = await apiFetch<{
        resetToken: string | null;
        expiresInMinutes: number;
      }>("/auth/forgot-password", {
        method: "POST",
        json: { email },
      });
      toast.success("Reset token generated");
      setResetToken(res.resetToken);
    } catch (err: any) {
      toast.error(err?.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Forgot Password</h1>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium">Email</label>
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <button
            className="w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Submitting…" : "Generate reset token"}
          </button>
        </form>

        {resetToken && (
          <div className="mt-4 rounded-md border bg-zinc-50 p-3 text-sm">
            <div className="font-medium">Reset token (no email configured)</div>
            <div className="mt-1 break-all font-mono">{resetToken}</div>
            <div className="mt-2">
              <Link
                className="underline"
                href={`/reset-password?token=${encodeURIComponent(resetToken)}`}
              >
                Go to Reset Password
              </Link>
            </div>
          </div>
        )}

        <div className="mt-4 text-sm">
          <Link className="underline" href="/login">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
