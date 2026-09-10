import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { setPromotionActive } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

/** Ending a promotion is { isActive: false }; the row stays for sale-line history. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/promotions/[id]">) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    const { id } = await ctx.params;
    return Response.json(await setPromotionActive(userId, id, await readJson(request)));
  } catch (e) {
    return errorResponse(e);
  }
}
