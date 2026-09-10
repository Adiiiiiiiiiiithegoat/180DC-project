/**
 * Drizzle wraps driver errors in a DrizzleQueryError and hangs the underlying
 * pg DatabaseError off `.cause`, so `err.code` is undefined at the top level.
 * Every place that needs to distinguish "the database refused this, and here is
 * exactly which rule" goes through here.
 */
export type PgErrorInfo = {
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
};

export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";

export function pgErrorOf(e: unknown): PgErrorInfo {
  const top = e as { cause?: unknown } | null;
  const cause = (top?.cause ?? e) as PgErrorInfo | null;
  return {
    code: cause?.code,
    constraint: cause?.constraint,
    table: cause?.table,
    detail: cause?.detail,
  };
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const info = pgErrorOf(e);
  if (info.code !== UNIQUE_VIOLATION) return false;
  return constraint ? info.constraint === constraint : true;
}
