/**
 * The authorisation boundary, checked on what the model actually receives:
 * each tool's input schema converted to JSON Schema by the AI SDK itself, the
 * same conversion that goes over the wire to the model.
 *
 * Run with the rest: npm test (tsx --conditions=react-server, so the
 * `server-only` marker in assistant.ts resolves outside Next).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asSchema } from "ai";
import { assistantTools, forModel } from "./assistant";

// Built for a made-up user: construction touches no database, and the point
// is that whoever it is, their id is not in anything the model can see.
const USER = "00000000-0000-4000-8000-000000000000";
const tools = assistantTools(USER);

async function modelFacing() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(tools).map(
        async ([name, t]) => [name, await asSchema(t.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema] as const,
      ),
    ),
  );
}

test("eight tools, and none of their schemas has any notion of a user", async () => {
  const schemas = await modelFacing();
  assert.deepEqual(Object.keys(schemas).sort(), [
    "findProduct",
    "getInventoryStatus",
    "getProductPerformance",
    "getReorderSuggestions",
    "getSalesSummary",
    "getSalesTimeSeries",
    "getStockHistory",
    "updateProductSettings",
  ]);
  const everything = JSON.stringify(schemas);
  assert.doesNotMatch(everything, /user|account|owner|tenant/i, "no user-ish field anywhere, names or descriptions");
  assert.ok(!everything.includes(USER), "the bound id never appears in a schema");
  if (process.env.PRINT_SCHEMAS) console.log(JSON.stringify(schemas, null, 2));
});

test("no tool takes SQL, a table or a column: every string input is narrow", async () => {
  const schemas = await modelFacing();
  const strings: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; properties?: Record<string, unknown> };
    if (n.type === "string") strings.push(path);
    for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, `${path}.${k}`);
  };
  for (const [name, s] of Object.entries(schemas)) walk(s, name);
  // The only free-text input is a product search string, capped at 100
  // characters and bound as a parameter to similarity(). Everything else is a
  // uuid, a date or an enum.
  assert.deepEqual(strings.sort(), [
    "findProduct.query",
    "getInventoryStatus.filter",
    "getProductPerformance.endDate",
    "getProductPerformance.sortBy",
    "getSalesSummary.endDate",
    "getSalesTimeSeries.endDate",
    "getSalesTimeSeries.granularity",
    "getStockHistory.productId",
    "updateProductSettings.productId",
  ]);
});

test("updateProductSettings: reorder point, price, active status, nothing else, and it needs approval", async () => {
  const schema = (await modelFacing()).updateProductSettings as {
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["isActive", "productId", "reorderPoint", "unitPrice"]);
  assert.equal(schema.additionalProperties, false, "a quantity field is rejected, not silently dropped");
  assert.equal(tools.updateProductSettings.needsApproval, true);

  const others = Object.entries(tools).filter(([n]) => n !== "updateProductSettings");
  assert.ok(others.every(([, t]) => !("needsApproval" in t) || !t.needsApproval), "the reads need no approval");

  const parsed = await asSchema(tools.updateProductSettings.inputSchema).validate?.({
    productId: USER,
    reorderPoint: 30,
    quantityOnHand: 999,
  });
  assert.equal(parsed?.success, false, "quantityOnHand is refused outright");
});

test("forModel formats paise and dates, so the model never converts either", () => {
  assert.deepEqual(
    forModel({ revenuePaise: 31415900, period: { from: "2026-08-11" }, livePromotion: null, units: 3 }),
    { revenue: "₹3,14,159.00", period: { from: "11 Aug 2026" }, units: 3 },
  );
});
