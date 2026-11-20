CREATE TABLE "prompt_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_key" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_presets_seed_key_unique" UNIQUE("seed_key")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retried_cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_presets_kind_name_uq" ON "prompt_presets" USING btree ("kind","name");