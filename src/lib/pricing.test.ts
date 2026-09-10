/**
 * Phase 2 verification. priceBasket is pure, so these are plain unit tests with
 * no database, no mocked clock, and no fixtures — `now` is just an argument.
 *
 * node:test and node:assert, so the pricing rules do not drag a test framework
 * into the dependency tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PricingError,
  allocateDiscount,
  lineRevenue,
  priceBasket,
  type Promotion,
  type PriceBasketResult,
} from "./pricing";

const NOW = new Date("2026-06-15T10:00:00Z");
const MUG = "prod-mug";
const PEN = "prod-pen";

function promo(over: Partial<Promotion> & { id: string }): Promotion {
  return {
    productId: MUG,
    type: "percent_off",
    percent: null,
    buyQty: null,
    getQty: null,
    priority: 0,
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-12-31T23:59:59Z"),
    isActive: true,
    ...over,
  } as Promotion;
}

const bogo = (over: Partial<Promotion> = {}) =>
  promo({ id: "promo-bogo", type: "buy_x_get_y", buyQty: 2, getQty: 1, ...over });

/**
 * Requirement 9: every total is an integer. Asserted explicitly, on every
 * result every test produces, rather than in one test that could pass while
 * another path returns a float.
 */
function assertAllIntegers(r: PriceBasketResult) {
  assert.ok(Number.isInteger(r.subtotal), `subtotal ${r.subtotal} not an integer`);
  assert.ok(Number.isInteger(r.total), `total ${r.total} not an integer`);
  assert.ok(
    Number.isInteger(r.discountTotal),
    `discountTotal ${r.discountTotal} not an integer`,
  );
  for (const l of r.lines) {
    assert.ok(
      Number.isInteger(l.discountAmount) && l.discountAmount >= 0,
      `discountAmount ${l.discountAmount} not a non-negative integer`,
    );
    assert.ok(lineRevenue(l) >= 0, `line revenue ${lineRevenue(l)} is negative`);
    assert.ok(Number.isInteger(l.listPrice), `listPrice ${l.listPrice} not an integer`);
    assert.ok(
      Number.isInteger(l.chargedPrice),
      `chargedPrice ${l.chargedPrice} not an integer`,
    );
  }
  for (const d of r.discounts) {
    assert.ok(Number.isInteger(d.amount), `discount ${d.amount} not an integer`);
  }
  // The books have to balance, not merely be integral. Line revenue is
  // quantity x charged price - discount amount.
  for (const l of r.lines) {
    assert.ok(Number.isInteger(l.quantity) && l.quantity > 0, `bad quantity ${l.quantity}`);
  }
  assert.equal(
    r.total,
    r.lines.reduce((s, l) => s + lineRevenue(l), 0),
    "total does not equal the sum of line revenues",
  );
  assert.equal(
    r.subtotal,
    r.lines.reduce((s, l) => s + l.quantity * l.listPrice, 0),
    "subtotal does not equal the sum of (quantity x list price)",
  );
  assert.equal(r.subtotal - r.discountTotal, r.total, "subtotal - discount != total");
}

test("1. no promotions: total is quantity times price", () => {
  const r = priceBasket([{ productId: MUG, quantity: 3, unitPrice: 25000 }], [], NOW);
  assert.equal(r.total, 75000);
  assert.equal(r.subtotal, 75000);
  assert.equal(r.discountTotal, 0);
  assert.equal(r.lines.length, 1, "three identical units are one line, not three rows");
  assert.equal(r.lines[0].quantity, 3);
  assert.equal(r.lines.filter((l) => l.isFreeUnit).length, 0);
  assertAllIntegers(r);
});

test("2. buy 2 get 1 free with exactly 3 units: 2 charged, 1 free", () => {
  const r = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 25000 }],
    [bogo()],
    NOW,
  );
  // DESIGN section 4: two lines, quantity 2 at 250 and quantity 1 at 0.
  assert.equal(r.lines.length, 2, "two lines, not three rows");
  assert.deepEqual(
    r.lines.map((l) => [l.quantity, l.chargedPrice]),
    [[2, 25000], [1, 0]],
    "charged line first, then the free-unit line",
  );
  const free = r.lines.filter((l) => l.isFreeUnit);
  assert.equal(free.length, 1);
  assert.equal(free[0].quantity, 1);
  assert.equal(free[0].chargedPrice, 0, "a free unit is charged 0");
  assert.equal(free[0].listPrice, 25000, "a free unit still records its list price");
  assert.equal(r.total, 50000);
  assert.equal(r.discountTotal, 25000);
  assertAllIntegers(r);
});

test("3. same promotion with 2 units: nothing free", () => {
  const r = priceBasket(
    [{ productId: MUG, quantity: 2, unitPrice: 25000 }],
    [bogo()],
    NOW,
  );
  assert.equal(r.lines.filter((l) => l.isFreeUnit).length, 0);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].quantity, 2);
  assert.equal(r.total, 50000);
  assert.equal(r.discountTotal, 0);
  assertAllIntegers(r);
});

test("4. same promotion with 7 units: 2 free, 5 charged", () => {
  const r = priceBasket(
    [{ productId: MUG, quantity: 7, unitPrice: 25000 }],
    [bogo()],
    NOW,
  );
  assert.equal(r.lines.length, 2, "one charged line and one free line");
  assert.deepEqual(
    r.lines.map((l) => [l.quantity, l.chargedPrice]),
    [[5, 25000], [2, 0]],
    "5 charged and 2 free, as quantities on two lines",
  );
  assert.equal(r.total, 125000);
  assertAllIntegers(r);
});

test("5. mixed prices under BOGO: the CHEAPEST unit is free, not the first", () => {
  // Same product entered three times at three prices — the sale screen lets the
  // cashier edit price inline, so this is a real basket, not a contrived one.
  const r = priceBasket(
    [
      { productId: MUG, quantity: 1, unitPrice: 30000 },
      { productId: MUG, quantity: 1, unitPrice: 10000 },
      { productId: MUG, quantity: 1, unitPrice: 20000 },
    ],
    [bogo()],
    NOW,
  );
  const free = r.lines.filter((l) => l.isFreeUnit);
  assert.equal(free.length, 1);
  assert.equal(free[0].quantity, 1);
  assert.equal(free[0].listPrice, 10000, "the 10000 unit should be the free one");
  // If the FIRST unit were taken instead the total would be 30000; assert the
  // number that distinguishes the two rules.
  assert.equal(r.total, 50000);
  assert.equal(r.discountTotal, 10000);
  assertAllIntegers(r);
});

test("6. a promotion whose ends_at is before now does not apply", () => {
  const expired = bogo({
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-06-14T23:59:59Z"), // yesterday, relative to NOW
  });
  const r = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 25000 }],
    [expired],
    NOW,
  );
  assert.equal(r.lines.filter((l) => l.isFreeUnit).length, 0);
  assert.equal(r.total, 75000);
  assertAllIntegers(r);

  // And the mirror case, so the date filter is not simply rejecting everything.
  const notYetStarted = bogo({ startsAt: new Date("2026-07-01T00:00:00Z") });
  const r2 = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 25000 }],
    [notYetStarted],
    NOW,
  );
  assert.equal(r2.total, 75000, "a promotion that has not started yet must not apply");

  // Inactive is a third way to not apply.
  const r3 = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 25000 }],
    [bogo({ isActive: false })],
    NOW,
  );
  assert.equal(r3.total, 75000, "an inactive promotion must not apply");
});

test("7. two promotions on one product: only the higher priority one applies", () => {
  // Ascending precedence, the P0/P1 convention: priority 1 outranks priority 5.
  const weak = promo({ id: "promo-weak", type: "percent_off", percent: 10, priority: 5 });
  const strong = promo({ id: "promo-strong", type: "percent_off", percent: 50, priority: 1 });

  const r = priceBasket(
    [{ productId: MUG, quantity: 1, unitPrice: 25000 }],
    [weak, strong],
    NOW,
  );
  assert.equal(r.total, 12500, "50% off should win, not 10%");
  assert.equal(r.discounts.length, 1, "no stacking: exactly one discount");
  assert.equal(r.discounts[0].promotionId, "promo-strong");
  assert.equal(r.lines[0].promotionId, "promo-strong");
  assertAllIntegers(r);

  // Order of the input array must not matter.
  const reversed = priceBasket(
    [{ productId: MUG, quantity: 1, unitPrice: 25000 }],
    [strong, weak],
    NOW,
  );
  assert.equal(reversed.total, 12500, "input order must not change the outcome");
});

test("8. sale-level discount across three lines: remainder to the largest, parts sum exactly", () => {
  const parts = allocateDiscount([10000, 20000, 30001], 1000);
  assert.equal(
    parts.reduce((s, p) => s + p, 0),
    1000,
    "the parts must sum exactly to the whole",
  );
  // floor gives 166 + 333 + 500 = 999; the stray paise goes to the largest line.
  assert.deepEqual(parts, [166, 333, 501]);

  // And through priceBasket, on a real three-line basket.
  const r = priceBasket(
    [
      { productId: MUG, quantity: 1, unitPrice: 10000 },
      { productId: PEN, quantity: 1, unitPrice: 20000 },
      { productId: "prod-jar", quantity: 1, unitPrice: 30001 },
    ],
    [],
    NOW,
    1000,
  );
  assert.equal(r.subtotal, 60001);
  assert.equal(r.discountTotal, 1000);
  assert.equal(r.total, 59001);
  // Each line's share lands in discountAmount; the per-unit prices are untouched.
  assert.deepEqual(r.lines.map((l) => l.discountAmount), [166, 333, 501]);
  assert.deepEqual(r.lines.map((l) => l.chargedPrice), [10000, 20000, 30001]);
  assertAllIntegers(r);
});

test("8b. allocation never loses or invents a paise, across many shapes", () => {
  // A property check by brute force, because rule 8 is the one that fails
  // silently: an off-by-one paise looks like nothing until the books disagree.
  const shapes = [
    [1, 1, 1],
    [1, 2, 3],
    [33, 33, 34],
    [99999, 1, 1],
    [7],
    [5000, 5000],
  ];
  for (const amounts of shapes) {
    const total = amounts.reduce((s, a) => s + a, 0);
    // The bottom of the range, and the top — near-100% discounts are where the
    // remainder can outgrow the largest line's headroom.
    const ds = new Set<number>();
    for (let d = 0; d <= Math.min(total, 200); d++) ds.add(d);
    for (let d = Math.max(0, total - 200); d <= total; d++) ds.add(d);
    for (const d of ds) {
      const parts = allocateDiscount(amounts, d);
      assert.equal(
        parts.reduce((s, p) => s + p, 0),
        d,
        `parts must sum to ${d} for ${JSON.stringify(amounts)}`,
      );
      parts.forEach((p, i) => {
        assert.ok(Number.isInteger(p), `part ${i} not an integer: ${p}`);
        assert.ok(p <= amounts[i], `part ${i} (${p}) exceeds its line (${amounts[i]}) at d=${d}`);
      });
    }
  }
});

test("9. every total is an integer, including on awkward percentages", () => {
  // 33% of 999 paise is 329.67 — the case where a float would leak through.
  const r = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 999 }],
    [promo({ id: "promo-33", type: "percent_off", percent: 33 })],
    NOW,
  );
  assertAllIntegers(r);
  assert.equal(r.lines.length, 1, "one product at one price is one line");
  assert.equal(r.lines[0].quantity, 3);
  assert.equal(r.lines[0].chargedPrice, 999 - 329, "charged price is per unit");
  // The floor is taken on the line: 33% of 2997 is 989.01, so 989 off. The
  // per-unit price carries 3 x 329 = 987 of it; the 2 paise that do not divide
  // into a whole per-unit price sit in discountAmount.
  assert.equal(r.lines[0].discountAmount, 2);
  assert.equal(r.discountTotal, 989);
  assert.equal(r.total, 2997 - 989);

  // A free unit and a percentage on two different products in one basket.
  const mixed = priceBasket(
    [
      { productId: MUG, quantity: 3, unitPrice: 333 },
      { productId: PEN, quantity: 2, unitPrice: 777 },
    ],
    [bogo(), promo({ id: "promo-pen", productId: PEN, type: "percent_off", percent: 7 })],
    NOW,
    13,
  );
  assertAllIntegers(mixed);
});

test("free units are their own line at charged 0, with a real quantity", () => {
  const r = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 25000 }],
    [bogo()],
    NOW,
  );
  assert.equal(r.lines.length, 2, "three units become two lines");
  assert.equal(r.lines.reduce((s, l) => s + l.quantity, 0), 3, "three units accounted for");
  const free = r.lines.find((l) => l.isFreeUnit)!;
  assert.equal(free.quantity, 1);
  assert.equal(free.chargedPrice, 0);
  assert.equal(free.promotionId, "promo-bogo", "the free unit names the promotion");
  assert.equal(r.discounts[0].label, "Buy 2 get 1 free");
});

test("a 10 rupee sale discount on a quantity-3 line at 100 is one line with discount_amount 1000", () => {
  // 1000 paise does not divide by 3. The line is NOT split into units at two
  // prices: it stays one line at 10000 per unit and carries the whole share.
  const r = priceBasket(
    [{ productId: MUG, quantity: 3, unitPrice: 10000 }],
    [],
    NOW,
    1000,
  );
  assert.equal(r.lines.length, 1, "never split");
  assert.equal(r.lines[0].quantity, 3);
  assert.equal(r.lines[0].chargedPrice, 10000, "per-unit price untouched");
  assert.equal(r.lines[0].discountAmount, 1000);
  assert.equal(lineRevenue(r.lines[0]), 29000);
  assert.equal(r.total, 29000);
  assertAllIntegers(r);
});

test("rule 8 remainder falls through when the largest line cannot absorb it", () => {
  // Three 1-paise lines, 2 paise off: every floor is 0, so the remainder is 2,
  // and no single line has room for 2. It goes down the lines in size order
  // (ties by position) instead of driving the largest line to -1.
  assert.deepEqual(allocateDiscount([1, 1, 1], 2), [1, 1, 0]);

  // The ordinary case is unchanged: the largest line takes the whole remainder.
  assert.deepEqual(allocateDiscount([10000, 20000, 30001], 1000), [166, 333, 501]);
});

test("exactly 100% off a multi-line basket: every line goes to zero, none below", () => {
  const r = priceBasket(
    [
      { productId: MUG, quantity: 3, unitPrice: 25000 },
      { productId: PEN, quantity: 2, unitPrice: 777 },
      { productId: "prod-jar", quantity: 1, unitPrice: 30001 },
    ],
    [bogo()],
    NOW,
    // Everything left to pay after the free mug: 2 x 250 + 2 x 7.77 + 300.01.
    50000 + 1554 + 30001,
  );
  assert.equal(r.total, 0);
  for (const l of r.lines) {
    assert.equal(lineRevenue(l), 0, `line ${l.productId} should be exactly zero`);
    assert.equal(l.discountAmount, l.quantity * l.chargedPrice, "the whole line is discounted, no more");
  }
  assert.equal(r.discountTotal, r.subtotal, "every paise of the subtotal is discounted");
  assertAllIntegers(r);
});

test("a sale discount bigger than the basket is refused with a clear message, never capped", () => {
  const basket = [{ productId: MUG, quantity: 3, unitPrice: 25000 }];
  assert.throws(
    () => priceBasket(basket, [], NOW, 75001),
    (e: unknown) =>
      e instanceof PricingError && /more than the subtotal of ₹750\.00/.test((e as Error).message),
  );
  // Under the subtotal but over what is left after buy-2-get-1 (500): also refused.
  assert.throws(
    () => priceBasket(basket, [bogo()], NOW, 60000),
    (e: unknown) =>
      e instanceof PricingError &&
      /more than the ₹500\.00 left to pay after promotions/.test((e as Error).message),
  );
  // Exactly what is left is fine.
  assert.equal(priceBasket(basket, [bogo()], NOW, 50000).total, 0);
});

test("percent off: the discount is within 1 paisa of the stated percent of the line, never over", () => {
  // Floor on the whole line (DESIGN section 4): the discount given is the exact
  // percentage of the line total rounded down, so it can fall short by less
  // than a paisa and can never exceed it. Checked in integers — 100 x discount
  // against quantity x price x percent — so the check itself has no float.
  for (const unitPrice of [1, 7, 333, 999, 1250, 25000, 99999]) {
    for (const percent of [1, 7, 10, 15, 33, 50, 67, 99, 100]) {
      for (let quantity = 1; quantity <= 10; quantity++) {
        const r = priceBasket(
          [{ productId: MUG, quantity, unitPrice }],
          [promo({ id: "pct", type: "percent_off", percent })],
          NOW,
        );
        const exactTimes100 = quantity * unitPrice * percent; // = 100 x exact discount
        const given = r.discountTotal;
        const where = `${percent}% of ${quantity} x ${unitPrice}`;
        assert.ok(given * 100 <= exactTimes100, `${where}: gave ${given}, more than stated`);
        assert.ok(exactTimes100 - given * 100 < 100, `${where}: gave ${given}, short by a paisa or more`);
        assert.equal(r.lines.length, 1, `${where}: never split`);
        assertAllIntegers(r);
      }
    }
  }
});

test("rejects non-integer money at the boundary", () => {
  assert.throws(
    () => priceBasket([{ productId: MUG, quantity: 1, unitPrice: 250.5 }], [], NOW),
    /integer/,
    "a float price must not be silently rounded into the ledger",
  );
});
