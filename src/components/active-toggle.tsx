"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { buttonQuiet } from "./ui";

/**
 * Deactivate is the delete: is_active = false. The row stays, because sale
 * lines and movements reference it forever; it just stops being sellable.
 */
export function ActiveToggle({
  path,
  isActive,
  activeLabel,
  inactiveLabel,
}: {
  path: string;
  isActive: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className={buttonQuiet}
        onClick={async () => {
          try {
            await api(path, "PATCH", { isActive: !isActive });
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {isActive ? activeLabel : inactiveLabel}
      </button>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </span>
  );
}
