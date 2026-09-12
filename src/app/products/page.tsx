import Link from "next/link";
import { ProductForm } from "@/components/product-form";
import { card, link, td, th } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { listProducts } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const userId = await requireUserId();
  const showAll = (await searchParams).show === "all";
  const rows = await listProducts(userId, { includeInactive: showAll });

  return (
    <div className="flex flex-col gap-6">
      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold">Add a product</h2>
        <ProductForm />
      </section>

      <section className={card}>
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Products</h1>
          <Link href={showAll ? "/products" : "/products?show=all"} className={`text-sm ${link}`}>
            {showAll ? "Hide deactivated" : "Show deactivated"}
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="products-table">
            <thead className="border-b border-stone-200">
              <tr>
                <th className={th}>Name</th>
                <th className={th}>SKU</th>
                <th className={th}>Category</th>
                <th className={`${th} text-right`}>Price</th>
                <th className={`${th} text-right`}>Avg cost</th>
                <th className={`${th} text-right`}>On hand</th>
                <th className={`${th} text-right`}>Reorder at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const low = p.isActive && p.quantityOnHand <= p.reorderPoint;
                return (
                  <tr
                    key={p.id}
                    data-sku={p.sku}
                    className={`border-b border-stone-100 ${p.isActive ? "" : "text-stone-400"}`}
                  >
                    <td className={td}>
                      <Link href={`/products/${p.id}`} className={`font-medium ${link}`}>
                        {p.name}
                      </Link>
                      {!p.isActive && <span className="ml-2 text-xs">(deactivated)</span>}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{p.sku}</td>
                    <td className={td}>{p.category}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatPaise(p.unitPrice)}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatPaise(p.averageCost)}</td>
                    <td
                      data-testid="on-hand"
                      className={`${td} text-right tabular-nums ${low ? "font-semibold text-amber-700" : ""}`}
                    >
                      {p.quantityOnHand}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{p.reorderPoint}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className={`${td} text-stone-500`}>
                    No products yet. Add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
