/**
 * One mapping from service-layer failures to HTTP, shared by every route, so
 * the same failure looks the same whichever endpoint produced it.
 */
import { ZodError } from "zod";
import { ServiceError, type ServiceErrorCode } from "./services";

const STATUS: Record<ServiceErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  insufficient_stock: 409,
  price_changed: 409,
  unsupported_file: 415,
  unreadable_document: 422,
  rate_limited: 429,
};

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized", message: "sign in first" }, { status: 401 });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError("invalid_input", "request body must be JSON");
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) {
    const message = e.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return Response.json({ error: "invalid_input", message, issues: e.issues }, { status: 400 });
  }
  if (e instanceof ServiceError) {
    const retryAfter = e.details?.retryAfterSeconds;
    return Response.json(
      { error: e.code, message: e.message, ...e.details },
      { status: STATUS[e.code], headers: typeof retryAfter === "number" ? { "retry-after": String(retryAfter) } : {} },
    );
  }
  console.error(e);
  return Response.json({ error: "internal", message: "something went wrong" }, { status: 500 });
}
