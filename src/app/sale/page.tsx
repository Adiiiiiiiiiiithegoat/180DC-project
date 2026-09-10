import { SaleScreen } from "@/components/sale-screen";
import { listLivePromotions, listProducts } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

export default async function SalePage() {
  const userId = await requireUserId();
  const [products, promotions] = await Promise.all([
    listProducts(userId),
    listLivePromotions(userId, new Date()),
  ]);

  return (
    <SaleScreen
      products={products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        unitPrice: p.unitPrice,
        quantityOnHand: p.quantityOnHand,
      }))}
      promotions={promotions.map((p) => ({
        ...p,
        type: p.type as "percent_off" | "buy_x_get_y",
        startsAt: p.startsAt.toISOString(),
        endsAt: p.endsAt.toISOString(),
      }))}
    />
  );
}
