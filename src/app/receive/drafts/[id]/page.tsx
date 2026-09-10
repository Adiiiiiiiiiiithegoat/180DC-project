import { notFound } from "next/navigation";
import { DraftReview } from "@/components/draft-review";
import { card } from "@/components/ui";
import { getDraft } from "@/lib/drafts";
import { listProducts } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

/** DESIGN.md section 3, step 5: check what was read, fix it, then confirm. */
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  const draft = await getDraft(userId, (await params).id);
  if (!draft) notFound();
  const products = await listProducts(userId);

  return (
    <section className={card}>
      <h1 className="mb-1 text-lg font-semibold">Check the delivery note</h1>
      <p className="mb-4 text-sm text-stone-500">
        Read from the upload; nothing has been received yet. Correct anything that is wrong, especially highlighted
        fields, then confirm.
      </p>
      <DraftReview
        draftId={draft.id}
        doc={draft.extraction}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          quantityOnHand: p.quantityOnHand,
          averageCost: p.averageCost,
        }))}
      />
    </section>
  );
}
