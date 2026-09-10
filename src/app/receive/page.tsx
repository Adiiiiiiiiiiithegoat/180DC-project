import Link from "next/link";
import { ReceiveForm } from "@/components/receive-form";
import { card } from "@/components/ui";
import { UploadNote } from "@/components/upload-note";
import { listDrafts } from "@/lib/drafts";
import { listProducts, listSuppliers } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

export default async function ReceivePage() {
  const userId = await requireUserId();
  const [products, suppliers, drafts] = await Promise.all([
    listProducts(userId),
    listSuppliers(userId),
    listDrafts(userId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <section className={card} aria-labelledby="upload-title">
        <h1 id="upload-title" className="mb-1 text-lg font-semibold">Receive from a delivery note</h1>
        <p className="mb-4 text-sm text-stone-500">
          Upload the supplier&apos;s note and check what was read before anything is received.
        </p>
        <UploadNote />
        {drafts.length > 0 && (
          <div className="mt-4 border-t border-stone-100 pt-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Waiting for review</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link href={`/receive/drafts/${d.id}`} className="hover:underline">
                    {d.supplierName ?? "Unknown supplier"} · {d.lines} line{d.lines === 1 ? "" : "s"} · uploaded{" "}
                    {d.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={card} aria-labelledby="manual-title">
        <h2 id="manual-title" className="mb-1 text-lg font-semibold">Receive goods by hand</h2>
        <p className="mb-4 text-sm text-stone-500">
          One confirmed receipt moves stock and updates each product&apos;s weighted average cost.
        </p>
        <ReceiveForm
          products={products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            quantityOnHand: p.quantityOnHand,
            averageCost: p.averageCost,
          }))}
          suppliers={suppliers}
        />
      </section>
    </div>
  );
}
