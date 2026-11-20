CREATE TABLE "analysis_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"focus" text DEFAULT '' NOT NULL,
	"field_definitions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summarizer_model" text NOT NULL,
	"report_model" text NOT NULL,
	"judge_reads_thinking" boolean DEFAULT false NOT NULL,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stop_reason" text,
	"error" text,
	"turns_completed" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"repetition_flag_turn" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"owner_id" text DEFAULT 'owner' NOT NULL,
	"name" text NOT NULL,
	"analysis_focus" text DEFAULT '' NOT NULL,
	"declared_variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shared_settings" jsonb,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definition" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"group" text NOT NULL,
	"presets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_definitions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"config" jsonb NOT NULL,
	"model_a" text NOT NULL,
	"model_b" text NOT NULL,
	"config_diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"speaker" text NOT NULL,
	"model" text NOT NULL,
	"text" text NOT NULL,
	"thinking_summary" text,
	"content" jsonb NOT NULL,
	"stop_reason" text NOT NULL,
	"usage" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"placeholder_used" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"max_tokens_used" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_versions" ADD CONSTRAINT "analysis_versions_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_versions_experiment_version_uq" ON "analysis_versions" USING btree ("experiment_id","version");--> statement-breakpoint
CREATE INDEX "analysis_versions_experiment_idx" ON "analysis_versions" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_run_index_uq" ON "conversations" USING btree ("run_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_experiment_number_uq" ON "runs" USING btree ("experiment_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_conversation_turn_uq" ON "turns" USING btree ("conversation_id","turn_number");