CREATE TABLE "comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text,
	"type_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"calculated_on" date,
	"pdf_file_id" uuid,
	"valid_until" date,
	"first_shared_at" timestamp with time zone,
	"view_token" text,
	"viewed_at" timestamp with time zone,
	"chosen_product_id" uuid,
	"linked_quotation_id" uuid,
	"reason" text,
	"status_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setting_id" text NOT NULL,
	"old_value" jsonb NOT NULL,
	"new_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"approval_ticket_id" uuid
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"include" text[] NOT NULL,
	"status" text NOT NULL,
	"file_id" uuid,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"inputs" jsonb NOT NULL,
	"ranked" jsonb NOT NULL,
	"chosen_product_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"financial_year" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text NOT NULL,
	"run_date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "job_runs_name_run_date_pk" PRIMARY KEY("name","run_date")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"meta_category" text,
	"language" text DEFAULT 'English' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"header_file_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"reject_reason" text,
	"meta_name" text,
	"template_version" integer DEFAULT 1 NOT NULL,
	"makers" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_ticket_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nominee_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text NOT NULL,
	"nominees" jsonb NOT NULL,
	"endorsement_ref" text,
	"effective_date" date,
	"endorsement_file_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occasion_exclusions" (
	"account_id" uuid NOT NULL,
	"person_key" text NOT NULL,
	"by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occasion_exclusions_account_id_person_key_pk" PRIMARY KEY("account_id","person_key")
);
--> statement-breakpoint
CREATE TABLE "occasion_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"birthday_template_id" uuid,
	"family_birthday_template_id" uuid,
	"anniversary_template_id" uuid,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outgoing_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid,
	"family_member_id" uuid,
	"person_name" text,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"attachment_file_id" uuid,
	"occurrence_key" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"provider_id" text,
	"provider_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"related_type" text,
	"related_id" uuid,
	"resend_of" uuid,
	"resend_count" integer DEFAULT 0 NOT NULL,
	"charged" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"status_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text DEFAULT 'QUOTATION' NOT NULL,
	"quotation_id" uuid,
	"revision_id" uuid,
	"policy_id" uuid,
	"insurer_id" uuid NOT NULL,
	"method" text,
	"link" text,
	"link_valid_until" date,
	"portal_amount" numeric(14, 2),
	"note" text,
	"status" text NOT NULL,
	"mode" text,
	"amount" numeric(14, 2),
	"paid_on" date,
	"reference" text,
	"reference_norm" text,
	"cheque_number" text,
	"cheque_bank" text,
	"cheque_date" date,
	"difference_reason" text,
	"difference_note" text,
	"receipt_file_id" uuid,
	"reason" text,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"source" text NOT NULL,
	"sold_by_me" boolean DEFAULT true NOT NULL,
	"insurer_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name" text NOT NULL,
	"type_id" uuid,
	"quotation_id" uuid,
	"revision_id" uuid,
	"proposal_id" uuid,
	"payment_id" uuid,
	"renewal_of_policy_id" uuid,
	"insurer_policy_number" text,
	"policy_number_norm" text,
	"issue_date" date,
	"start_date" date,
	"end_date" date,
	"frequency" text,
	"next_due_date" date,
	"sum_insured" numeric(14, 2),
	"sum_insured_reason" text,
	"premium" numeric(14, 2),
	"insured" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declarations" jsonb,
	"document_file_id" uuid,
	"notes" text,
	"expected_commission" numeric(14, 2),
	"grace_days" integer,
	"nominee_required" boolean DEFAULT false NOT NULL,
	"max_nominees" integer,
	"status" text NOT NULL,
	"cancel_reason" text,
	"cancel_date" date,
	"refund_amount" numeric(14, 2),
	"cancel_note" text,
	"snapshot" jsonb,
	"status_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"policy_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"quotation_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"members" jsonb NOT NULL,
	"declarations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nominees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_id" uuid,
	"reason" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"breakdown" jsonb,
	"snapshot" jsonb,
	"price_version_id" uuid,
	"calculated_on" date,
	"final_payable" numeric(14, 2),
	"pdf_file_id" uuid,
	"pdf_checksum" text,
	"valid_until" date,
	"first_shared_at" timestamp with time zone,
	"view_token" text,
	"viewed_at" timestamp with time zone,
	"reason" text,
	"reason_note" text,
	"status_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text,
	"product_id" uuid,
	"insurer_id" uuid,
	"type_id" uuid,
	"renewal_of_policy_id" uuid,
	"from_comparison_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"valid_until" date NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "referral_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text,
	"knows_as" text NOT NULL,
	"interest_type_id" uuid NOT NULL,
	"city" text,
	"message" text,
	"result" text NOT NULL,
	"lead_id" uuid,
	"customer_id" uuid,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrer_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"renewal_date" date NOT NULL,
	"grace_end" date NOT NULL,
	"status" text NOT NULL,
	"reminders_paused" boolean DEFAULT false NOT NULL,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_contact_at" timestamp with time zone,
	"last_outcome" text,
	"reason" text,
	"note" text,
	"renewal_quotation_id" uuid,
	"renewed_by_policy_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"outcome" text,
	"from_status" text,
	"to_status" text,
	"note" text,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"message_id" uuid,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"subscription_id" uuid,
	"plan" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"cgst" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"sgst" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"igst" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"gstin" text,
	"state" text,
	"source" text NOT NULL,
	"reference" text,
	"reference_norm" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"ticket_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_views" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text,
	"label" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"balance_after" numeric(14, 2),
	"message_id" uuid,
	"order_id" uuid,
	"reason" text,
	"by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_numbers" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"number" text,
	"requested_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominee_versions" ADD CONSTRAINT "nominee_versions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasion_settings" ADD CONSTRAINT "occasion_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "quotation_revisions_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrer_profiles" ADD CONSTRAINT "referrer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD CONSTRAINT "renewal_cycles_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comparisons_number" ON "comparisons" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "comparisons_token" ON "comparisons" USING btree ("view_token");--> statement-breakpoint
CREATE INDEX "comparisons_customer" ON "comparisons" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_one_pending" ON "config_changes" USING btree ("setting_id") WHERE "config_changes"."status" = 'PENDING_APPROVAL';--> statement-breakpoint
CREATE INDEX "exports_account" ON "export_jobs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "fit_logs_account" ON "fit_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_orders_payment" ON "gateway_orders" USING btree ("gateway_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_orders_order" ON "gateway_orders" USING btree ("gateway_order_id");--> statement-breakpoint
CREATE INDEX "gateway_orders_account" ON "gateway_orders" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name" ON "message_templates" USING btree (lower("name"),"channel","language");--> statement-breakpoint
CREATE UNIQUE INDEX "nominees_one_current" ON "nominee_versions" USING btree ("policy_id") WHERE "nominee_versions"."status" = 'CURRENT';--> statement-breakpoint
CREATE UNIQUE INDEX "nominees_version" ON "nominee_versions" USING btree ("policy_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_occurrence" ON "outgoing_messages" USING btree ("occurrence_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider" ON "outgoing_messages" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "messages_account_status" ON "outgoing_messages" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX "messages_customer" ON "outgoing_messages" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_queue" ON "outgoing_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_paid" ON "payments" USING btree ("quotation_id") WHERE "payments"."status" = 'PAID' and "payments"."quotation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_awaiting" ON "payments" USING btree ("revision_id") WHERE "payments"."status" = 'AWAITING_PAYMENT';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference" ON "payments" USING btree ("account_id","insurer_id","reference_norm") WHERE "payments"."status" = 'PAID' and "payments"."reference_norm" is not null;--> statement-breakpoint
CREATE INDEX "payments_quotation" ON "payments" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "payments_policy" ON "payments" USING btree ("policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_number" ON "policies" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_insurer_number" ON "policies" USING btree ("account_id","insurer_id","policy_number_norm") WHERE "policies"."policy_number_norm" is not null;--> statement-breakpoint
CREATE INDEX "policies_customer" ON "policies" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "policies_account_status" ON "policies" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_number" ON "proposals" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_open" ON "proposals" USING btree ("quotation_id") WHERE "proposals"."status" in ('DRAFT','SUBMITTED');--> statement-breakpoint
CREATE INDEX "proposals_account_status" ON "proposals" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "qrev_no" ON "quotation_revisions" USING btree ("quotation_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "qrev_one_draft" ON "quotation_revisions" USING btree ("quotation_id") WHERE "quotation_revisions"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "qrev_one_live" ON "quotation_revisions" USING btree ("quotation_id") WHERE "quotation_revisions"."status" in ('READY','SHARED','ACCEPTED');--> statement-breakpoint
CREATE UNIQUE INDEX "qrev_token" ON "quotation_revisions" USING btree ("view_token");--> statement-breakpoint
CREATE INDEX "qrev_account_status" ON "quotation_revisions" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_number" ON "quotations" USING btree ("account_id","number");--> statement-breakpoint
CREATE INDEX "quotations_customer" ON "quotations" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_code_unique" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_one_active" ON "referral_codes" USING btree ("referrer_user_id") WHERE "referral_codes"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "referrals_referrer" ON "referral_submissions" USING btree ("referrer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "referrals_account" ON "referral_submissions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "renewal_policy_date" ON "renewal_cycles" USING btree ("policy_id","renewal_date");--> statement-breakpoint
CREATE INDEX "renewal_account_status" ON "renewal_cycles" USING btree ("account_id","status","renewal_date");--> statement-breakpoint
CREATE INDEX "renewal_events_cycle" ON "renewal_events" USING btree ("cycle_id","at");--> statement-breakpoint
CREATE INDEX "share_events_record" ON "share_events" USING btree ("record_id","at");--> statement-breakpoint
CREATE INDEX "share_events_account_day" ON "share_events" USING btree ("account_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number" ON "subscription_invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_offline_ref" ON "subscription_invoices" USING btree ("reference_norm") WHERE "subscription_invoices"."source" = 'OFFLINE';--> statement-breakpoint
CREATE INDEX "invoices_account" ON "subscription_invoices" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_one_active" ON "support_grants" USING btree ("staff_user_id","account_id") WHERE "support_grants"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "grants_account" ON "support_grants" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "support_views_grant" ON "support_views" USING btree ("grant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_debit_once" ON "wallet_transactions" USING btree ("message_id") WHERE "wallet_transactions"."kind" = 'DEBIT';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_order_once" ON "wallet_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "wallet_account" ON "wallet_transactions" USING btree ("account_id","created_at");