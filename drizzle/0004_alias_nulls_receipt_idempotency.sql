ALTER TABLE "supplier_aliases" DROP CONSTRAINT "supplier_aliases_key";--> statement-breakpoint
-- Aliases are now stored UPPERCASE with whitespace collapsed (normalizeLineText). Bring existing rows
-- to that form, keeping one row where two now coincide, so the new constraint can be added.
UPDATE "supplier_aliases" SET "raw_text" = upper(regexp_replace(btrim("raw_text"), '\s+', ' ', 'g'));--> statement-breakpoint
DELETE FROM "supplier_aliases" a USING "supplier_aliases" b
 WHERE a."user_id" = b."user_id" AND a."supplier_id" IS NOT DISTINCT FROM b."supplier_id"
   AND a."raw_text" = b."raw_text" AND a."id" > b."id";--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_idempotency_key" UNIQUE("user_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "supplier_aliases" ADD CONSTRAINT "supplier_aliases_key" UNIQUE NULLS NOT DISTINCT("user_id","supplier_id","raw_text");