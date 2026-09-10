import { errorResponse, readJson, unauthorized } from "@/lib/http";
import { recordSale } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    const sale = await recordSale(userId, await readJson(request));
    // A replayed idempotency key is not a new resource: 200, not 201.
    return Response.json(sale, { status: sale.idempotentReplay ? 200 : 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
