CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"category" text,
	"unit_price" integer NOT NULL,
	"average_cost" integer DEFAULT 0 NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_user_sku_key" UNIQUE("user_id","sku"),
	CONSTRAINT "products_unit_price_check" CHECK ("products"."unit_price" >= 0),
	CONSTRAINT "products_average_cost_check" CHECK ("products"."average_cost" >= 0),
	CONSTRAINT "products_quantity_on_hand_check" CHECK ("products"."quantity_on_hand" >= 0),
	CONSTRAINT "products_reorder_point_check" CHECK ("products"."reorder_point" >= 0),
	CONSTRAINT "products_lead_time_days_check" CHECK ("products"."lead_time_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"type" text NOT NULL,
	"percent" integer,
	"buy_qty" integer,
	"get_qty" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "promotions_type_check" CHECK ("promotions"."type" IN ('percent_off','buy_x_get_y')),
	CONSTRAINT "promotions_percent_check" CHECK ("promotions"."percent" BETWEEN 1 AND 100),
	CONSTRAINT "promotions_buy_qty_check" CHECK ("promotions"."buy_qty" > 0),
	CONSTRAINT "promotions_get_qty_check" CHECK ("promotions"."get_qty" > 0),
	CONSTRAINT "promotions_shape_check" CHECK (("promotions"."type" = 'percent_off' AND "promotions"."percent" IS NOT NULL) OR ("promotions"."type" = 'buy_x_get_y' AND "promotions"."buy_qty" IS NOT NULL AND "promotions"."get_qty" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" uuid,
	"raw_text" text,
	"quantity" integer NOT NULL,
	"unit_cost" integer NOT NULL,
	CONSTRAINT "receipt_lines_quantity_check" CHECK ("receipt_lines"."quantity" > 0),
	CONSTRAINT "receipt_lines_unit_cost_check" CHECK ("receipt_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"supplier_id" uuid,
	"reference" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_status_check" CHECK ("receipts"."status" IN ('draft','confirmed')),
	CONSTRAINT "receipts_source_check" CHECK ("receipts"."source" IN ('manual','upload'))
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"list_price" integer NOT NULL,
	"charged_price" integer NOT NULL,
	"unit_cost" integer NOT NULL,
	"promotion_id" uuid,
	"is_free_unit" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sale_lines_quantity_check" CHECK ("sale_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subtotal" integer NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"cost_total" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_user_idempotency_key" UNIQUE("user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"reference_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_check" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_reason_check" CHECK ("stock_movements"."reason" IN ('receipt','sale','return','adjustment'))
);
--> statement-breakpoint
CREATE TABLE "supplier_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"supplier_id" uuid,
	"raw_text" text NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "supplier_aliases_key" UNIQUE("user_id","supplier_id","raw_text")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_user_name_key" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_aliases" ADD CONSTRAINT "supplier_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_aliases" ADD CONSTRAINT "supplier_aliases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_aliases" ADD CONSTRAINT "supplier_aliases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_user_active_idx" ON "products" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "promotions_lookup_idx" ON "promotions" USING btree ("user_id","product_id","is_active");--> statement-breakpoint
CREATE INDEX "receipts_user_status_idx" ON "receipts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_user_time_idx" ON "sales" USING btree ("user_id","sold_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movements_product_time_idx" ON "stock_movements" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movements_user_time_idx" ON "stock_movements" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");