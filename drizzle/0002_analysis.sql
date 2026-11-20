CREATE TABLE "codings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_version_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"output" jsonb,
	"raw_output" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_transcripts" integer DEFAULT 0 NOT NULL,
	"opened" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nudges" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"content" text,
	"warning" text,
	"citation_check" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cross_similarity" double precision;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "emoji_count" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "model_mentions" jsonb;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_analysis_version_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_version_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_analysis_version_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_version_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "codings_version_conversation_uq" ON "codings" USING btree ("analysis_version_id","conversation_id");--> statement-breakpoint
CREATE INDEX "codings_conversation_idx" ON "codings" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_version_run_uq" ON "reports" USING btree ("analysis_version_id","run_id");