import { discardDraft } from "@/lib/drafts";
import { errorResponse, unauthorized } from "@/lib/http";
import { sessionUserId } from "@/lib/session";

/** Throw a draft away. It never moved stock, so there is nothing to undo. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/receipts/drafts/[id]">) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    await discardDraft(userId, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
