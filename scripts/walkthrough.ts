/**
 * Phase 4 walkthrough, driven through the real UI in headless Edge, with stock
 * read back from both the page and the database at every step.
 *
 *   npm run dev            (in another terminal)
 *   npm run walkthrough
 *
 * Signs up a fresh account, adds two products, puts a buy-2-get-1 promotion on
 * one, receives stock, then rings up a sale at the till: typed search, Enter to
 * add, an inline quantity edit, a blocked out-of-stock line, and the charge.
 * Finishes by signing in as the seeded demo account.
 *
 * playwright-core drives the Edge already installed on this machine; it does
 * not download browsers.
 */
import "./env";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { chromium, type Page } from "playwright-core";
import { db, pool } from "../src/db";
import { users } from "../src/db/auth-schema";
import { products, saleLines, sales, stockMovements } from "../src/db/schema";
import { DEMO } from "./seed-account";

const BASE = process.env.WALKTHROUGH_URL ?? "http://localhost:3000";
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "walkthrough";
mkdirSync(OUT, { recursive: true });

let shot = 0;
async function snap(page: Page, name: string) {
  const file = join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`      screenshot: ${file}`);
}

function step(title: string) {
  console.log(`\n== ${title}`);
}

function check(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) {
    process.exitCode = 1;
    throw new Error(`walkthrough check failed: ${label}`);
  }
}

async function stockFromDb(userId: string, sku: string) {
  const [p] = await db
    .select({ q: products.quantityOnHand, avg: products.averageCost })
    .from(products)
    .where(and(eq(products.userId, userId), eq(products.sku, sku)));
  return p;
}

async function stockFromProductsPage(page: Page, sku: string) {
  await page.goto(`${BASE}/products`);
  const cell = page.locator(`tr[data-sku="${sku}"] [data-testid="on-hand"]`);
  await cell.waitFor();
  return Number(await cell.innerText());
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(60_000); // first hit of each route compiles in dev

  const email = `walkthrough-${Date.now()}@example.com`;

  try {
    step("1. Sign up");
    await page.goto(`${BASE}/sign-up`);
    await page.getByLabel("Shop name").fill("Walkthrough Stores");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("walkthrough-pass");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(`${BASE}/products`);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    check("account created and signed in", !!user, email);
    const userId = user.id;
    await snap(page, "signed-up");

    step("2. Add two products");
    const form = page.locator("form").first();
    for (const p of [
      { name: "Blue Mug", sku: "MUG-01", category: "Kitchen", price: "250", reorder: "4" },
      { name: "Ceramic Plate", sku: "PLT-01", category: "Kitchen", price: "180", reorder: "3" },
    ]) {
      await form.getByLabel("Name").fill(p.name);
      await form.getByLabel("SKU").fill(p.sku);
      await form.getByLabel("Category").fill(p.category);
      await form.getByLabel("Price").fill(p.price);
      await form.getByLabel("Reorder point").fill(p.reorder);
      await form.getByRole("button", { name: "Add product" }).click();
      await page.getByText(`Added ${p.name}`).waitFor();
      await page.locator(`tr[data-sku="${p.sku}"]`).waitFor();
    }
    for (const sku of ["MUG-01", "PLT-01"]) {
      const ui = await stockFromProductsPage(page, sku);
      const dbq = (await stockFromDb(userId, sku)).q;
      check(`${sku} starts at 0`, ui === 0 && dbq === 0, `page ${ui}, database ${dbq}`);
    }
    await snap(page, "products-added");

    step("3. Put Buy 2 get 1 free on the Blue Mug");
    await page.getByRole("link", { name: "Blue Mug" }).click();
    await page.getByRole("button", { name: "Add promotion" }).click();
    await page.getByText("Promotion added").waitFor();
    await page.getByRole("cell", { name: "Buy 2 get 1 free" }).waitFor();
    check("promotion is live", await page.getByRole("cell", { name: "live" }).isVisible());
    await snap(page, "promotion");

    step("4. Receive stock: 10 mugs at 80, 6 plates at 95");
    await page.goto(`${BASE}/receive`);
    await page.getByLabel("Supplier").fill("Walkthrough Supplier");
    await page.getByLabel("Delivery note ref").fill("DN-WALK-1");
    const rows = page.locator("tbody tr");
    await rows.nth(0).getByLabel("Product").selectOption({ label: "Blue Mug (MUG-01)" });
    await rows.nth(0).getByLabel("Quantity").fill("10");
    await rows.nth(0).getByLabel("Unit cost").fill("80");
    await page.getByRole("button", { name: "Add line" }).click();
    await rows.nth(1).getByLabel("Product").selectOption({ label: "Ceramic Plate (PLT-01)" });
    await rows.nth(1).getByLabel("Quantity").fill("6");
    await rows.nth(1).getByLabel("Unit cost").fill("95");
    await snap(page, "receipt-filled");
    await page.getByRole("button", { name: "Confirm receipt" }).click();
    await page.getByText("Received 16 units on 2 line(s)").waitFor();
    for (const [sku, want, cost] of [["MUG-01", 10, 8000], ["PLT-01", 6, 9500]] as const) {
      const ui = await stockFromProductsPage(page, sku);
      const d = await stockFromDb(userId, sku);
      check(
        `${sku} stock after receipt`,
        ui === want && d.q === want && d.avg === cost,
        `page ${ui}, database ${d.q}, average cost ${d.avg} paise`,
      );
    }
    await snap(page, "stock-after-receipt");

    step("5. Ring up a sale at the till");
    await page.goto(`${BASE}/sale`);
    const search = page.getByLabel("Search products");
    await search.waitFor();
    check(
      "search box has focus on load",
      await search.evaluate((el) => el === document.activeElement),
    );
    // A scanner is a keyboard: the SKU typed, then Enter.
    await page.keyboard.type("MUG-01");
    await page.keyboard.press("Enter");
    await page.getByLabel("Quantity of Blue Mug").waitFor();
    check("Enter added the mug line", (await page.getByLabel("Quantity of Blue Mug").inputValue()) === "1");
    check("focus returned to search for the next scan", await search.evaluate((el) => el === document.activeElement));
    await page.getByLabel("Quantity of Blue Mug").fill("3");
    // Typed name, top match, Enter.
    await search.fill("plate");
    await search.press("Enter");
    await page.getByLabel("Quantity of Ceramic Plate").waitFor();

    const discountRow = page.getByTestId("discount");
    await discountRow.waitFor();
    const discountText = await discountRow.innerText();
    check(
      "total names the promotion behind the discount",
      /Buy 2 get 1 free/.test(discountText) && /Blue Mug/.test(discountText) && /250\.00/.test(discountText),
      discountText.replace(/\s+/g, " "),
    );
    const total = await page.getByTestId("total").innerText();
    check("total is 2 x 250 + 180 = 680", total === "₹680.00", total);
    await snap(page, "basket-with-bogo");

    // Out-of-stock is blocked at the line, not on submit.
    await page.getByLabel("Quantity of Ceramic Plate").fill("7");
    // Scoped to the basket: Next.js renders its own hidden role="alert" route announcer.
    const alert = page.getByTestId("basket").getByRole("alert");
    await alert.waitFor();
    check("7 plates is blocked at the line", (await alert.innerText()) === "Only 6 in stock");
    check("charge is disabled while a line is blocked", await page.getByRole("button", { name: /^Charge/ }).isDisabled());
    await snap(page, "out-of-stock-blocked");
    await page.getByLabel("Quantity of Ceramic Plate").fill("1");

    await page.getByRole("button", { name: /^Charge/ }).click();
    await page.getByText("Sale recorded: ₹680.00").waitFor();
    await snap(page, "sale-recorded");

    step("6. Stock after the sale");
    for (const [sku, want] of [["MUG-01", 7], ["PLT-01", 5]] as const) {
      const ui = await stockFromProductsPage(page, sku);
      const d = await stockFromDb(userId, sku);
      check(`${sku} stock after sale`, ui === want && d.q === want, `page ${ui}, database ${d.q}`);
    }
    await snap(page, "stock-after-sale");

    const [sale] = await db.select().from(sales).where(eq(sales.userId, userId));
    const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
    console.log("   sale lines as stored:");
    for (const l of lines) {
      console.log(
        `     qty ${l.quantity}  list ${l.listPrice}  charged ${l.chargedPrice}  ` +
          `discount_amount ${l.discountAmount}  unit_cost ${l.unitCost}  free=${l.isFreeUnit}`,
      );
    }
    const moves = await db
      .select({ q: stockMovements.quantity, reason: stockMovements.reason })
      .from(stockMovements)
      .where(and(eq(stockMovements.userId, userId), eq(stockMovements.referenceId, sale.id)));
    console.log(`   sale movements: ${moves.map((m) => m.q).sort((a, b) => a - b).join(", ")}`);
    check(
      "BOGO stored as two mug lines (2 at 250, 1 free) plus the plate",
      lines.length === 3 &&
        lines.some((l) => l.quantity === 2 && l.chargedPrice === 25000) &&
        lines.some((l) => l.quantity === 1 && l.isFreeUnit && l.chargedPrice === 0),
    );
    check("one movement per line, 4 units in all", moves.length === 3 && moves.reduce((s, m) => s + m.q, 0) === -4);
    check(
      "revenue 680, cost 3 x 80 + 95 = 335",
      sale.total === 68000 && sale.costTotal === 3 * 8000 + 9500,
      `total ${sale.total}, cost ${sale.costTotal}`,
    );

    await page.goto(`${BASE}/products`);
    await page.getByRole("link", { name: "Blue Mug" }).click();
    await page.getByTestId("ledger").waitFor();
    await snap(page, "mug-ledger");

    step("7. Sign in as the seeded demo account");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(`${BASE}/sign-in`);
    await page.getByLabel("Email").fill(DEMO.email);
    await page.getByLabel("Password").fill(DEMO.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${BASE}/sale`);
    await page.getByLabel("Search products").fill("bisc");
    await page.getByLabel("Search products").press("Enter");
    await page.getByLabel("Quantity of Glucose Biscuits 250g").fill("3");
    await page.getByTestId("discount").waitFor();
    check(
      "seeded BOGO promotion applies with no setup",
      /Buy 2 get 1 free/.test(await page.getByTestId("discount").innerText()),
    );
    await snap(page, "demo-sale-screen");
    await page.goto(`${BASE}/products`);
    await page.getByTestId("products-table").waitFor();
    await snap(page, "demo-products");

    const [{ n }] = (
      await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM products p JOIN users u ON u.id = p.user_id WHERE u.email = ${DEMO.email}`)
    ).rows;
    check("demo catalogue is loaded", n === 20, `${n} products`);
    console.log("\nWALKTHROUGH PASSED");
  } finally {
    await browser.close();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
