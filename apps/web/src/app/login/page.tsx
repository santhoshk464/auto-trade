"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch<{ user: { id: string } }>("/auth/login", {
        method: "POST",
        json: { email, password },
      });
      toast.success("Logged in success");
      router.push("/dashboard");
    } catch (err: any) {
      toast.error(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel — gradient branding */}
      <div className="hidden lg:flex lg:w-[45%] flex-col justify-between bg-linear-to-br from-indigo-900 via-indigo-800 to-blue-900 p-12 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -right-32 w-md h-112 rounded-full bg-white/5" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full bg-white/3" />

        {/* Logo */}
        <div className="relative z-10">
          <div className="flex items-center gap-2">
            <span className="text-2xl"></span>
            <span className="text-white text-xl font-bold tracking-tight">AutoTrade</span>
          </div>
        </div>

        {/* Center content */}
        <div className="relative z-10">
          <h2 className="text-white text-3xl font-bold leading-snug mb-4">
            Intelligent<br />Options Trading
          </h2>
          <p className="text-indigo-200 text-sm mb-8">
            Automate your strategy with precision-built hedging and order management.
          </p>
          <ul className="space-y-3">
            {["Smart Stop-Loss Management", "Auto Hedge on Entry", "OCO Target & SL Orders", "Live Trade Monitoring"].map((f) => (
              <li key={f} className="flex items-center gap-3 text-indigo-100 text-sm">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/30 text-indigo-300">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* Footer tagline */}
        <div className="relative z-10 text-indigo-300 text-xs">
          NSE Options  Zerodha Kite Connect
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex flex-col bg-white dark:bg-zinc-900">
        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-4">
          {/* Mobile logo */}
          <div className="flex items-center gap-2 lg:hidden">
            <span className="text-lg"></span>
            <span className="font-bold text-zinc-900 dark:text-zinc-100">AutoTrade</span>
          </div>
          <div className="hidden lg:block" />
          <ThemeToggle />
        </div>

        {/* Form area */}
        <div className="flex-1 flex items-center justify-center px-8 py-12">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              Welcome back
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-8">
              Sign in to your AutoTrade account
            </p>

            <form className="space-y-5" onSubmit={onSubmit}>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  Email address
                </label>
                <input
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-4 py-2.5 pr-12 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label="Toggle password visibility"
                  >
                    {showPassword ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <button
                className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 text-sm transition-colors disabled:opacity-60 mt-2"
                disabled={loading}
                type="submit"
              >
                {loading ? "Signing in" : "Sign in"}
              </button>
            </form>

            <div className="mt-6 flex items-center justify-between text-sm">
              <Link
                href="/register"
                className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
              >
                Create account
              </Link>
              <Link
                href="/forgot-password"
                className="text-zinc-500 dark:text-zinc-400 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

