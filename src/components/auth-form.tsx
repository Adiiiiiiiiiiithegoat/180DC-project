"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { button, card, input, label } from "./ui";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setBusy(true);
    setError(null);
    const { error } =
      mode === "sign-up"
        ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message ?? "That did not work");
      return;
    }
    router.push(mode === "sign-up" ? "/products" : "/dashboard");
    router.refresh();
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <form onSubmit={onSubmit} className={`${card} flex flex-col gap-3`}>
        <h1 className="text-lg font-semibold">
          {mode === "sign-up" ? "Create your shop" : "Sign in"}
        </h1>
        {mode === "sign-up" && (
          <label className={label}>
            Shop name
            <input name="name" required className={input} />
          </label>
        )}
        <label className={label}>
          Email
          <input name="email" type="email" required autoComplete="email" className={input} />
        </label>
        <label className={label}>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            className={input}
          />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={busy} className={button}>
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
        <p className="text-center text-xs text-stone-500">
          {mode === "sign-up" ? (
            <>Already have an account? <Link href="/sign-in" className="underline">Sign in</Link></>
          ) : (
            <>New here? <Link href="/sign-up" className="underline">Create an account</Link></>
          )}
        </p>
      </form>
    </div>
  );
}
