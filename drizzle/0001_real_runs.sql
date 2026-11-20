ALTER TABLE "runs" ADD COLUMN "stop_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "repetition" double precision;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "signed_off" boolean DEFAULT false NOT NULL;