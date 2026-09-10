import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { createPromotion } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    return Response.json(await createPromotion(userId, await readJson(request)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
