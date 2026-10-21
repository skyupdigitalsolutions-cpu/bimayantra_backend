CREATE TABLE "advisor_kyc" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"pan_enc" text,
	"pan_index" text,
	"name_on_pan" text,
	"pan_file_id" uuid,
	"licence_file_id" uuid,
	"declared_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"reject_note" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "kyc_status_check" CHECK ("advisor_kyc"."status" in ('NOT_SUBMITTED','PENDING_REVIEW','VERIFIED','REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"purpose" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"scan" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurer_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"insurer_id" uuid NOT NULL,
	"agent_code" text NOT NULL,
	"code_valid_until" date,
	"appointment_file_id" uuid,
	"declared_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"flagged_for_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_code" text NOT NULL,
	"category" text NOT NULL,
	"irdai_reg_no" text NOT NULL,
	"website" text,
	"payment_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"care_number" text,
	"care_email" text,
	"logo_file_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"message_id" text NOT NULL,
	"text" text NOT NULL,
	"link_type" text,
	"link_id" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'UNREAD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"linked_type" text,
	"linked_id" uuid,
	"notes" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"reminded_for_due_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "photo_file_id" uuid;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "personal_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "alt_mobile" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "pin_code" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "contact_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "advisor_type" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "licence_number" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "licence_valid_until" date;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "experience_years" integer;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "authorised_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "professional_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "business_name" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "logo_file_id" uuid;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "business_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "last_milestone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "advisor_kyc" ADD CONSTRAINT "advisor_kyc_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD CONSTRAINT "insurer_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD CONSTRAINT "insurer_mappings_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kyc_queue" ON "advisor_kyc" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "files_account" ON "files" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insurance_types_name" ON "insurance_types" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "insurer_mappings_unique" ON "insurer_mappings" USING btree ("account_id","insurer_id");--> statement-breakpoint
CREATE INDEX "insurer_mappings_code" ON "insurer_mappings" USING btree ("insurer_id","agent_code");--> statement-breakpoint
CREATE UNIQUE INDEX "insurers_name" ON "insurers" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "insurers_code" ON "insurers" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_account_due" ON "tasks" USING btree ("account_id","status","due_at");--> statement-breakpoint
-- Accounts created in Phase 1 get their KYC row (P-06)
INSERT INTO "advisor_kyc" ("account_id") SELECT "account_id" FROM "advisor_profiles" ON CONFLICT DO NOTHING;
