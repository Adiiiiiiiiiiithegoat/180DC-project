import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { updateProduct } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

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
