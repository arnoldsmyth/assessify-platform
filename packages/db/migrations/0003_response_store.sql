CREATE TYPE "public"."response_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TABLE "questionnaire_response_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"language" text,
	"status" "response_status" DEFAULT 'draft' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{"currentSectionKey":null,"answeredCount":0,"totalCount":0}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_responses_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "questionnaire_response_events" ADD CONSTRAINT "questionnaire_response_events_session_id_respondent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_session_id_respondent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_events_session_idx" ON "questionnaire_response_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "responses_order_idx" ON "questionnaire_responses" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "responses_product_status_idx" ON "questionnaire_responses" USING btree ("product_id","status");