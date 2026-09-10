import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

/**
 * Display only: shows links when there is a session. This is not an auth
 * check — every page and route handler does its own.
 */
export async function Nav() {
  const session = await auth.api.getSession({ headers: await headers() });
  return (
    <header className="border-b border-stone-200 bg-white">
      <nav className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold tracking-tight">
          Stockroom
        </Link>
        {session && (
          <>
            <Link href="/dashboard" className="text-stone-600 hover:text-stone-900">Dashboard</Link>
            <Link href="/assistant" className="text-stone-600 hover:text-stone-900">Assistant</Link>
            <Link href="/sale" className="text-stone-600 hover:text-stone-900">Sale</Link>
            <Link href="/receive" className="text-stone-600 hover:text-stone-900">Receive</Link>
            <Link href="/products" className="text-stone-600 hover:text-stone-900">Products</Link>
            <span className="ml-auto text-stone-500">{session.user.email}</span>
            <SignOutButton />
          </>
        )}
      </nav>
    </header>
  );
}
