"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** A nav link that marks itself active for its route (and any route beneath it). */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "border-b-2 border-brand-green-dark pb-0.5 font-medium text-brand-green-dark"
          : "border-b-2 border-transparent pb-0.5 text-stone-600 hover:text-stone-900"
      }
    >
      {children}
    </Link>
  );
}
