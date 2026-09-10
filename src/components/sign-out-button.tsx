"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { buttonQuiet } from "./ui";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className={buttonQuiet}
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
