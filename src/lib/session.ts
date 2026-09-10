/**
 * The only two ways code finds out who the user is. Both read the session;
 * neither accepts a user id from anywhere else.
 *
 * There is no auth check in middleware/proxy (DESIGN.md section 10):
 * CVE-2025-29927 showed middleware-only protection in Next.js can be bypassed
 * by spoofing the `x-middleware-subrequest` header. Every page and every route
 * handler calls one of these itself, at the top.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

/** For server-rendered pages: no session means the sign-in page. */
export async function requireUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return session.user.id;
}

/** For route handlers: null means the handler answers 401. */
export async function sessionUserId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}
