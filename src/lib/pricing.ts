/**
 * DESIGN.md section 4 — pricing is a function, not a lookup.
 *
 * Pure. No database calls, no clock reads: `now` is a parameter, so "this
 * promotion expired yesterday" is a unit test rather than a mocked clock.
 *
 * It must see the whole basket, because "buy 2 get 1 free" is unanswerable
 * while looking at a single item.
 *
 * Money is integers in paise throughout. Every arithmetic step here is integer
 * arithmetic; there is no float anywhere in this file.
 */
import { formatPaise } from "./money";

export type BasketLine = {
  productId: string;
  quantity: number;
  /** Paise. Defaults from the product, but the cashier may edit it inline. */
  unitPrice: number;
};

export type Promotion = {
  id: string;
  productId: string;
  type: "percent_off" | "buy_x_get_y";
  percent?: number | null;
  buyQty?: number | null;
  getQty?: number | null;
  priority: number;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
};

export type PricedLine = {
  productId: string;
  /**
   * A real quantity. DESIGN section 4: "lines carry quantity, they are not
   * split one row per unit". Three mugs under buy-2-get-1 are two lines —
   * quantity 2 at 250 and quantity 1 at 0 — and the service layer writes one
   * movement per line carrying that line's signed quantity.
   */
  quantity: number;
  /** Per unit, not the line total. */
  listPrice: number;
  /** Per unit, not the line total. 0 for a free-unit line. */
  chargedPrice: number;
  /**
   * A whole-line amount in paise, taken off after quantity x charged price.
   * It holds whatever cannot be expressed as a whole-paise change to the
   * per-unit price: the line's share of a sale-level discount, and the
   * rounding remainder of a percent-off promotion. A line is never split into
   * two lines at adjacent prices to avoid it.
   *
   *   line revenue = quantity x chargedPrice - discountAmount
   */
  discountAmount: number;
  promotionId: string | null;
  isFreeUnit: boolean;
};

/** quantity x chargedPrice - discountAmount. The one definition of line revenue. */
export function lineRevenue(l: PricedLine): number {
  return l.quantity * l.chargedPrice - l.discountAmount;
}

export type AppliedDiscount = {
  /** null for the sale-level discount, which is not a promotion. */
  promotionId: string | null;
  productId: string | null;
  /** Human-readable, for the sale screen's "which promotion caused this". */
  label: string;
  amount: number;
};

export type PriceBasketResult = {
  lines: PricedLine[];
  discounts: AppliedDiscount[];
  /** Sum of list prices, before any discount. */
  subtotal: number;
  discountTotal: number;
  total: number;
};

/**
 * A basket that cannot be priced as asked — for now, a sale discount larger
 * than what is left to pay. The service layer turns it into a 400 with this
 * message, and the sale screen shows it in place of a total.
 */
export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

function assertInt(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${what} must be an integer number of paise, got ${value}`);
  }
}

/**
 * Selects the one promotion that applies to a product, or null.
 *
 * Ordered by priority then id, first match wins, no stacking (DESIGN section
 * 4). Explicit ordering because Postgres guarantees no row order without an
 * ORDER BY, and nondeterministic pricing makes tests flap.
 *
 * Precedence is ASCENDING priority: priority 0 is applied first, the P0/P1
 * convention, as DESIGN section 4 documents. `id` breaks ties so two
 * promotions at the same priority still resolve deterministically.
 */
export function selectPromotion(
  productId: string,
  activePromotions: readonly Promotion[],
  now: Date,
): Promotion | null {
  const candidates = activePromotions
    .filter(
      (p) =>
        p.productId === productId &&
        p.isActive &&
        p.startsAt.getTime() <= now.getTime() &&
        p.endsAt.getTime() >= now.getTime(),
    )
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return candidates[0] ?? null;
}

/**
 * Splits `discount` across `amounts` in proportion to each amount.
 *
 * DESIGN section 5, rule 8. Integer division drops fractions, so the floored
 * parts sum to less than the whole. The remainder goes to the largest line
 * that can absorb it: normally the largest line outright, but a discount close
 * to the whole basket can leave the largest line with less headroom than the
 * remainder, and a line must never be discounted below zero. Then it falls
 * through to the next largest, and only if no single line can take all of it
 * is it spread down the lines in size order — which always fits, because the
 * total headroom is at least the remainder when discount <= total.
 *
 * Ties on size break by lowest index, so the allocation is deterministic.
 */
export function allocateDiscount(
  amounts: readonly number[],
  discount: number,
): number[] {
  amounts.forEach((a, i) => assertInt(a, `amounts[${i}]`));
  assertInt(discount, "discount");
  if (discount < 0) throw new PricingError("a discount cannot be negative");

  const total = amounts.reduce((s, a) => s + a, 0);
  if (discount > total) {
    throw new PricingError(`a discount of ${discount} is more than the ${total} it applies to`);
  }
  if (discount === 0) return amounts.map(() => 0);

  // BigInt for the product: discount x amount can pass 2^53 on a large
  // basket, where a float division would stop being an exact floor.
  const parts = amounts.map((a) => Number((BigInt(discount) * BigInt(a)) / BigInt(total)));
  let remainder = discount - parts.reduce((s, p) => s + p, 0);

  const bySize = amounts
    .map((_, i) => i)
    .sort((x, y) => amounts[y] - amounts[x] || x - y);
  const headroom = (i: number) => amounts[i] - parts[i];

  const taker = bySize.find((i) => headroom(i) >= remainder);
  if (taker !== undefined) {
    parts[taker] += remainder;
  } else {
    for (const i of bySize) {
      const take = Math.min(headroom(i), remainder);
      parts[i] += take;
      remainder -= take;
      if (remainder === 0) break;
    }
  }

  if (parts.reduce((s, p) => s + p, 0) !== discount) {
    throw new Error("allocation does not sum to the discount");
  }
  if (parts.some((p, i) => p > amounts[i])) {
    throw new Error("allocation discounted a line below zero");
  }
  return parts;
}

/**
 * One unit of one product.
 *
 * Pricing works per unit internally even though the output carries quantities:
 * "the cheapest qualifying unit is the free one" is unanswerable while looking
 * at a line of quantity 3. Units are grouped back into lines at the end.
 */
type Unit = {
  index: number;
  /** Position of this unit's product in the input, so output order is stable. */
  productOrder: number;
  productId: string;
  listPrice: number;
  chargedPrice: number;
  promotionId: string | null;
  isFreeUnit: boolean;
};

type UnitGroup = {
  units: Unit[];
  minIndex: number;
  productOrder: number;
};

/**
 * Collapses units into lines. Units group when they are indistinguishable on
 * the sale line: same product, same list price, same charged price, same
 * promotion, same free-unit flag.
 *
 * Ordering: product order of first appearance, then charged lines before their
 * free-unit line, then original position. That is what makes three mugs under
 * BOGO come out as "quantity 2 at 250, quantity 1 at 0" rather than the free
 * line first.
 */
function groupUnits(units: readonly Unit[]): UnitGroup[] {
  const groups = new Map<string, UnitGroup>();
  for (const u of units) {
    const key = [
      u.productId,
      u.listPrice,
      u.chargedPrice,
      u.promotionId ?? "",
      u.isFreeUnit,
    ].join("|");
    const existing = groups.get(key);
    if (existing) {
      existing.units.push(u);
      existing.minIndex = Math.min(existing.minIndex, u.index);
    } else {
      groups.set(key, { units: [u], minIndex: u.index, productOrder: u.productOrder });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.productOrder - b.productOrder ||
      Number(a.units[0].isFreeUnit) - Number(b.units[0].isFreeUnit) ||
      a.minIndex - b.minIndex,
  );
}

function toPricedLine(group: UnitGroup): PricedLine {
  const first = group.units[0];
  return {
    productId: first.productId,
    quantity: group.units.length,
    listPrice: first.listPrice,
    chargedPrice: first.chargedPrice,
    discountAmount: 0,
    promotionId: first.promotionId,
    isFreeUnit: first.isFreeUnit,
  };
}

export function priceBasket(
  lines: readonly BasketLine[],
  activePromotions: readonly Promotion[],
  now: Date,
  /**
   * Optional whole-sale discount in paise, applied after promotions and
   * allocated across lines by allocateDiscount. Promotions are per product;
   * this is the cashier knocking money off the whole basket.
   */
  saleDiscount = 0,
): PriceBasketResult {
  // Expand to one entry per unit. BOGO on a mixed-price basket needs per-unit
  // granularity: the cheapest qualifying unit is the free one, and that is not
  // answerable while looking at a line of quantity 3.
  const units: Unit[] = [];
  const productOrder = new Map<string, number>();
  for (const line of lines) {
    assertInt(line.quantity, "quantity");
    assertInt(line.unitPrice, "unitPrice");
    if (line.quantity <= 0) throw new Error("quantity must be greater than 0");
    if (line.unitPrice < 0) throw new Error("unitPrice must not be negative");
    if (!productOrder.has(line.productId)) {
      productOrder.set(line.productId, productOrder.size);
    }
    for (let i = 0; i < line.quantity; i++) {
      units.push({
        index: units.length,
        productOrder: productOrder.get(line.productId)!,
        productId: line.productId,
        listPrice: line.unitPrice,
        chargedPrice: line.unitPrice,
        promotionId: null,
        isFreeUnit: false,
      });
    }
  }

  const discounts: AppliedDiscount[] = [];
  const percentOff = new Map<string, { percent: number; productId: string }>();

  const byProduct = new Map<string, Unit[]>();
  for (const u of units) {
    const group = byProduct.get(u.productId);
    if (group) group.push(u);
    else byProduct.set(u.productId, [u]);
  }

  for (const [productId, group] of byProduct) {
    const promo = selectPromotion(productId, activePromotions, now);
    if (!promo) continue;

    if (promo.type === "percent_off") {
      if (promo.percent == null) throw new Error(`promotion ${promo.id} has no percent`);
      // The whole-paise part of the discount goes on the per-unit price here.
      // The line-level remainder, and the discount entry, are settled after
      // grouping, because "floor the discount" is applied to the LINE.
      for (const u of group) {
        u.chargedPrice = u.listPrice - Math.floor((u.listPrice * promo.percent) / 100);
        u.promotionId = promo.id;
      }
      percentOff.set(promo.id, { percent: promo.percent, productId });
      continue;
    }

    // buy_x_get_y
    const buyQty = promo.buyQty;
    const getQty = promo.getQty;
    if (buyQty == null || getQty == null) {
      throw new Error(`promotion ${promo.id} has no buy/get quantities`);
    }
    const groupSize = buyQty + getQty;
    const freeCount = Math.floor(group.length / groupSize) * getQty;
    if (freeCount === 0) continue;

    // The cheapest qualifying units are the free ones, not the first ones.
    // Tie-break on original index so a mixed basket prices identically every
    // time it is priced.
    const cheapestFirst = [...group].sort(
      (a, b) => a.listPrice - b.listPrice || a.index - b.index,
    );
    let amount = 0;
    for (const u of cheapestFirst.slice(0, freeCount)) {
      amount += u.listPrice;
      u.chargedPrice = 0;
      u.isFreeUnit = true;
      u.promotionId = promo.id;
    }
    discounts.push({
      promotionId: promo.id,
      productId,
      label: `Buy ${buyQty} get ${getQty} free`,
      amount,
    });
  }

  const subtotal = units.reduce((s, u) => s + u.listPrice, 0);
  const pricedLines = groupUnits(units).map(toPricedLine);

  /**
   * Percent-off, settled per line. DESIGN section 4: floor the discount
   * amount, so rounding never gives away more than the promotion states. The
   * floor is taken on the line — 33% of 3 x 999 is 989.01, so 989 — and the
   * per-unit price above only carries 3 x 329 = 987 of it. The 2 paise that do
   * not divide into a whole per-unit price go into discountAmount.
   */
  for (const [promotionId, { percent, productId }] of percentOff) {
    let amount = 0;
    for (const line of pricedLines) {
      if (line.promotionId !== promotionId) continue;
      const lineDiscount = Math.floor((line.quantity * line.listPrice * percent) / 100);
      const onUnitPrice = line.quantity * (line.listPrice - line.chargedPrice);
      line.discountAmount += lineDiscount - onUnitPrice;
      amount += lineDiscount;
    }
    if (amount > 0) {
      discounts.push({ promotionId, productId, label: `${percent}% off`, amount });
    }
  }

  // Validated up front and refused with a clear message, never silently
  // capped: a cashier who types 900 on a 500 basket has made a mistake the
  // screen should show, not one the till should quietly correct.
  assertInt(saleDiscount, "saleDiscount");
  if (saleDiscount < 0) throw new PricingError("a sale discount cannot be negative");
  if (saleDiscount > subtotal) {
    throw new PricingError(
      `a sale discount of ${formatPaise(saleDiscount)} is more than the subtotal of ${formatPaise(subtotal)}`,
    );
  }
  const revenues = pricedLines.map(lineRevenue);
  const payable = revenues.reduce((s, r) => s + r, 0);
  // Stricter than the subtotal whenever a promotion applies: three mugs at 250
  // under buy-2-get-1 have a 750 subtotal but only 500 left to discount.
  if (saleDiscount > payable) {
    throw new PricingError(
      `a sale discount of ${formatPaise(saleDiscount)} is more than the ${formatPaise(payable)} left to pay after promotions`,
    );
  }

  if (saleDiscount > 0) {
    // DESIGN section 5, rule 8, one level: split across lines by line total,
    // remainder to the largest line that can absorb it, parts asserted to sum
    // to the whole. Each share lands in discountAmount; the per-unit price is
    // left alone, so a line is never split to absorb a share that does not
    // divide by its quantity.
    const parts = allocateDiscount(revenues, saleDiscount);
    parts.forEach((part, i) => {
      pricedLines[i].discountAmount += part;
    });
    discounts.push({
      promotionId: null,
      productId: null,
      label: "Sale discount",
      amount: saleDiscount,
    });
  }

  const total = pricedLines.reduce((s, l) => s + lineRevenue(l), 0);
  const discountTotal = subtotal - total;

  // DESIGN section 5, rule 7: money is integers in paise. Assert it rather
  // than trust it — a float that reaches here is a bug that gets written to
  // the database and never noticed.
  assertInt(subtotal, "subtotal");
  assertInt(total, "total");
  assertInt(discountTotal, "discountTotal");
  for (const line of pricedLines) {
    assertInt(line.discountAmount, "discountAmount");
    if (line.discountAmount < 0) throw new Error("discountAmount must not be negative");
    if (lineRevenue(line) < 0) throw new Error("line revenue must not be negative");
  }
  if (total < 0) throw new Error("total must not be negative");
  if (discountTotal !== discounts.reduce((s, d) => s + d.amount, 0)) {
    throw new Error("discount lines do not sum to discountTotal");
  }
  const lineUnits = pricedLines.reduce((s, l) => s + l.quantity, 0);
  if (lineUnits !== units.length) {
    throw new Error(`grouped lines cover ${lineUnits} units but basket has ${units.length}`);
  }

  return { lines: pricedLines, discounts, subtotal, discountTotal, total };
}
