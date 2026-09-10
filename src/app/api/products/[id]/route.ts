import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { getProduct } from "@/lib/queries";
import { updateProduct } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

/**
 * One product, as it is now. The assistant's approval card uses it to show
 * the real current values next to a proposed change, from the database
 * rather than from anything the model wrote.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/products/[id]">) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  const product = await getProduct(userId, (await ctx.params).id);
  if (!product) return Response.json({ error: "not_found", message: "no such product" }, { status: 404 });
  return Response.json(product);
}

/** Edit settings, or deactivate with { isActive: false }. There is no DELETE. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/products/[id]">) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    const { id } = await ctx.params;
    return Response.json(await updateProduct(userId, id, await readJson(request)));
  } catch (e) {
    return errorResponse(e);
  }
}
