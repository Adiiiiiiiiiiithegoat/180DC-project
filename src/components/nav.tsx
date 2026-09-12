import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NavLink } from "./nav-link";
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
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/assistant">Assistant</NavLink>
            <NavLink href="/sale">Sale</NavLink>
            <NavLink href="/receive">Receive</NavLink>
            <NavLink href="/products">Products</NavLink>
            <span className="ml-auto text-stone-500">{session.user.email}</span>
            <SignOutButton />
          </>
        )}
      </nav>
    </header>
  );
}
