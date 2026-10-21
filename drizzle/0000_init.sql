CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"kyc_status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"completion_percent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"actor_job" text,
	"account_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"result" text DEFAULT 'SUCCESS' NOT NULL,
	"request_id" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "auth_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_values" (
	"id" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"default_value" jsonb NOT NULL,
	"change_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'IN_PROGRESS' NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"code_hash" text NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"wrong_tries" integer DEFAULT 0 NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"context" jsonb,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_locks" (
	"mobile" text NOT NULL,
	"purpose" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "otp_locks_mobile_purpose_pk" PRIMARY KEY("mobile","purpose")
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"prev_refresh_hash" text,
	"refresh_rotated_at" timestamp with time zone,
	"device_name" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"plan" text,
	"status" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_clock" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"offset_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"mobile" text NOT NULL,
	"status" text NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('ADV','AST','REF','STF','ADM')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('INVITED','ACTIVE','DISABLED')),
	CONSTRAINT "users_account_check" CHECK (("users"."role" in ('STF','ADM')) = ("users"."account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"balance" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "wallets_balance_not_negative" CHECK ("wallets"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "advisor_profiles" ADD CONSTRAINT "advisor_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tickets" ADD CONSTRAINT "auth_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_account_at" ON "audit_log" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "audit_entity" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "otp_one_open" ON "otp_challenges" USING btree ("mobile","purpose") WHERE "otp_challenges"."status" = 'ISSUED';--> statement-breakpoint
CREATE INDEX "otp_mobile_created" ON "otp_challenges" USING btree ("mobile","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_account_name" ON "pipelines" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "sessions_user_active" ON "sessions" USING btree ("user_id") WHERE "sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_current" ON "subscriptions" USING btree ("account_id") WHERE "subscriptions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "users_mobile_unique" ON "users" USING btree ("mobile");--> statement-breakpoint
CREATE INDEX "users_account_idx" ON "users" USING btree ("account_id");