ALTER TABLE "insurer_mappings" ADD COLUMN IF NOT EXISTS "verification" text DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD COLUMN IF NOT EXISTS "verification_note" text;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD COLUMN IF NOT EXISTS "verification_read" jsonb;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insurer_mappings" ADD COLUMN IF NOT EXISTS "verified_by" uuid;
