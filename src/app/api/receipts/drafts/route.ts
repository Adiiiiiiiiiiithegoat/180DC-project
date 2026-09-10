import { uploadToDraft } from "@/lib/drafts";
import { MAX_UPLOAD_BYTES } from "@/lib/extraction";
import { errorResponse, unauthorized } from "@/lib/http";
import { ServiceError } from "@/lib/services";
import { sessionUserId } from "@/lib/session";

/**
 * Upload a delivery note; get back a draft receipt to review (DESIGN.md
 * section 3). Multipart, one file in the `file` field. Nothing here moves
 * stock, and the file is processed in memory and never stored.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();
  try {
    // Refuse an obviously oversize body before buffering it. The real size is
    // checked again on the bytes; this header is only the client's claim.
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
      throw new ServiceError("unsupported_file", "The file is larger than 20 MB.");
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      throw new ServiceError("invalid_input", "send the document as multipart form data in a field named 'file'");
    }
    // file.type is the browser's say-so and is ignored: the bytes decide what the file is.
    const draft = await uploadToDraft(userId, new Uint8Array(await file.arrayBuffer()));
    return Response.json(draft, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
