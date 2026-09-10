import { ReceiveForm } from "@/components/receive-form";
import { card } from "@/components/ui";
import { listProducts, listSuppliers } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

export default async function ReceivePage() {
  const userId = await requireUserId();
  const [products, suppliers] = await Promise.all([listProducts(userId), listSuppliers(userId)]);

  return (
    <section className={card}>
      <h1 className="mb-1 text-lg font-semibold">Receive goods</h1>
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
  );
}
