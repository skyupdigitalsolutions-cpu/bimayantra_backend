CREATE TABLE "account_counters" (
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_counters_account_id_kind_pk" PRIMARY KEY("account_id","kind")
);
--> statement-breakpoint
CREATE TABLE "consent_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"consent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"address" text,
	"how" text,
	"evidence_file_id" uuid,
	"by_user_id" uuid,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"family_member_id" uuid,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"address" text,
	"how" text,
	"evidence_file_id" uuid,
	"terms_version" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"linked_customer_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"full_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"date_of_birth" date,
	"gender" text,
	"mobile" text NOT NULL,
	"alt_mobile" text,
	"email" text,
	"preferred_contact" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"pin_code" text,
	"anniversary" date,
	"occupation" text,
	"source" text DEFAULT 'Direct' NOT NULL,
	"lead_id" uuid,
	"referrer_user_id" uuid,
	"referred_by_customer_id" uuid,
	"campaign" text,
	"notes" text,
	"pan_enc" text,
	"pan_index" text,
	"pan_masked" text,
	"aadhaar_enc" text,
	"aadhaar_masked" text,
	"default_nominee" jsonb,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"inactive_reason" text,
	"inactive_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_label_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"old_label" text NOT NULL,
	"new_label" text NOT NULL,
	"by_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"status" text NOT NULL,
	"read_values" jsonb,
	"confirmed_values" jsonb,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"family_member_id" uuid,
	"vehicle_id" uuid,
	"type" text NOT NULL,
	"name" text,
	"slot" text,
	"label" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"relationship" text NOT NULL,
	"date_of_birth" date,
	"gender" text,
	"anniversary" date,
	"mobile" text,
	"email" text,
	"photo_file_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"outcome" text,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"note" text,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"mobile" text NOT NULL,
	"alt_mobile" text,
	"email" text,
	"source" text NOT NULL,
	"referrer_user_id" uuid,
	"referred_by_customer_id" uuid,
	"campaign" text,
	"interest_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"next_follow_up_at" timestamp with time zone,
	"follow_up_task_id" uuid,
	"lost_reason" text,
	"lost_note" text,
	"customer_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"registration" text NOT NULL,
	"vehicle_type" text NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"year" integer NOT NULL,
	"fuel" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_counters" ADD CONSTRAINT "account_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_linked_customer_id_customers_id_fk" FOREIGN KEY ("linked_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_label_changes" ADD CONSTRAINT "document_label_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_history_consent" ON "consent_history" USING btree ("consent_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_person_channel" ON "consents" USING btree ("customer_id",coalesce("family_member_id", '00000000-0000-0000-0000-000000000000'::uuid),"channel");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_links_pair" ON "customer_links" USING btree ("customer_id","linked_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_number" ON "customers" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_active_exact" ON "customers" USING btree ("account_id","mobile","name_norm") WHERE "customers"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "customers_account_status" ON "customers" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "customers_account_mobile" ON "customers" USING btree ("account_id","mobile");--> statement-breakpoint
CREATE INDEX "customers_pan" ON "customers" USING btree ("account_id","pan_index");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_no" ON "document_versions" USING btree ("document_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_person_type" ON "documents" USING btree ("customer_id",coalesce("family_member_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("vehicle_id", '00000000-0000-0000-0000-000000000000'::uuid),"type",coalesce(lower("name"), ''),coalesce("slot", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "documents_label" ON "documents" USING btree ("customer_id",lower("label"));--> statement-breakpoint
CREATE INDEX "documents_customer" ON "documents" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_active_name_rel" ON "family_members" USING btree ("customer_id","name_norm","relationship") WHERE "family_members"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "family_customer" ON "family_members" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "lead_events_lead" ON "lead_events" USING btree ("lead_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_number" ON "leads" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_open_exact" ON "leads" USING btree ("account_id","mobile","name_norm") WHERE "leads"."status" not in ('CONVERTED','LOST');--> statement-breakpoint
CREATE INDEX "leads_account_status" ON "leads" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX "leads_account_mobile" ON "leads" USING btree ("account_id","mobile");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_registration" ON "vehicles" USING btree ("account_id","registration");--> statement-breakpoint
CREATE INDEX "vehicles_customer" ON "vehicles" USING btree ("customer_id");