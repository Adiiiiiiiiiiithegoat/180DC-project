import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { receiveGoods } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    return Response.json(await receiveGoods(userId, await readJson(request)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
