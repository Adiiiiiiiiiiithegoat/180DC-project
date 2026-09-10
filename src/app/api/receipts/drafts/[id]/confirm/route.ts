import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { receiveGoods } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

/**
 * Confirm a reviewed draft: the lines as the person corrected them. This is
 * receiveGoods — the function manual entry calls — told which draft it is
 * confirming. One transaction: receipt, lines, movements, average costs.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/receipts/drafts/[id]/confirm">) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    const body = await readJson(request);
    const receipt = await receiveGoods(
      userId,
      { ...(body as Record<string, unknown>), source: "upload" },
      { draftId: (await ctx.params).id },
    );
    return Response.json(receipt, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
