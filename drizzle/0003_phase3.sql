CREATE TABLE "ocr_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"product_version_id" uuid,
	"template_version_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"raw" jsonb,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_key" text NOT NULL,
	"account_id" uuid,
	"product_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" text NOT NULL,
	"tax_percent" numeric(5, 2) NOT NULL,
	"rows" jsonb NOT NULL,
	"rider_prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "price_status_check" CHECK ("price_versions"."status" in ('CURRENT','SCHEDULED','CLOSED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "product_commercials" (
	"account_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"commission_percent" numeric(5, 2) NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_commercials_account_id_product_id_pk" PRIMARY KEY("account_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "product_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"field" text NOT NULL,
	"field_label" text NOT NULL,
	"current_value" text,
	"proposed_value" text NOT NULL,
	"reason" text NOT NULL,
	"file_id" uuid,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"resulting_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"template_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"uin" text,
	"data" jsonb NOT NULL,
	"makers" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"correction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"reject_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_ticket_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"insurer_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'UPCOMING' NOT NULL,
	"status_reason" text,
	"published_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_kind_check" CHECK (("products"."kind" = 'VERIFIED') = ("products"."account_id" is null)),
	CONSTRAINT "products_status_check" CHECK ("products"."status" in ('UPCOMING','ACTIVE','WITHDRAWN'))
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"makers" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"reject_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_ticket_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "pending_change" jsonb;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "makers" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insurance_types" ADD COLUMN "approval_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "pending_change" jsonb;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "makers" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insurers" ADD COLUMN "approval_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_commercials" ADD CONSTRAINT "product_commercials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_commercials" ADD CONSTRAINT "product_commercials_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_corrections" ADD CONSTRAINT "product_corrections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_corrections" ADD CONSTRAINT "product_corrections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_type_id_insurance_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."insurance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_type_id_insurance_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."insurance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_one_open" ON "ocr_jobs" USING btree ("file_id",coalesce("product_version_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "ocr_jobs"."status" in ('QUEUED','PROCESSING','REVIEW_REQUIRED');--> statement-breakpoint
CREATE UNIQUE INDEX "price_one_open" ON "price_versions" USING btree ("owner_key","product_id") WHERE "price_versions"."effective_to" is null and "price_versions"."status" <> 'CANCELLED';--> statement-breakpoint
CREATE UNIQUE INDEX "price_seq" ON "price_versions" USING btree ("owner_key","product_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "corrections_one_open" ON "product_corrections" USING btree ("account_id","product_id","field") WHERE "product_corrections"."status" = 'SUBMITTED';--> statement-breakpoint
CREATE INDEX "corrections_queue" ON "product_corrections" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_one_published" ON "product_versions" USING btree ("product_id") WHERE "product_versions"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE UNIQUE INDEX "product_one_open" ON "product_versions" USING btree ("product_id") WHERE "product_versions"."status" in ('DRAFT','PENDING_APPROVAL');--> statement-breakpoint
CREATE UNIQUE INDEX "product_version_no" ON "product_versions" USING btree ("product_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "products_verified_code" ON "products" USING btree ("insurer_id","code") WHERE "products"."kind" = 'VERIFIED';--> statement-breakpoint
CREATE UNIQUE INDEX "products_own_code" ON "products" USING btree ("account_id","insurer_id","code") WHERE "products"."kind" = 'OWN';--> statement-breakpoint
CREATE INDEX "products_account" ON "products" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_one_active" ON "template_versions" USING btree ("type_id") WHERE "template_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "template_one_open" ON "template_versions" USING btree ("type_id") WHERE "template_versions"."status" in ('DRAFT','PENDING_APPROVAL');--> statement-breakpoint
CREATE UNIQUE INDEX "template_version_no" ON "template_versions" USING btree ("type_id","version_no");