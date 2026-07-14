CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending_dns', 'verifying', 'active', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('purchase', 'usage', 'adjustment', 'expiry', 'refund');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'pending', 'approved', 'sent', 'processing_report', 'completed', 'cancelled', 'payment_error', 'email_error', 'on_hold', 'refunded', 'resend_email', 'scoring_error');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('named', 'bulk_named', 'multi_rater', 'group', 'retail', 'batch_code');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'offline', 'gocardless');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('requires_action', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."plan_type" AS ENUM('prepay_credits', 'seat_licence', 'flat_access', 'postpay');--> statement-breakpoint
CREATE TYPE "public"."report_model" AS ENUM('individual', 'aggregate', 'both');--> statement-breakpoint
CREATE TYPE "public"."role_name" AS ENUM('super_admin', 'assessment_admin', 'client_admin', 'client_user', 'assessment_taker');--> statement-breakpoint
CREATE TYPE "public"."royalty_method" AS ENUM('pct_net_revenue', 'fixed_per_completion', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."scoring_mode" AS ENUM('sync_internal', 'async_external');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('created', 'invited', 'started', 'completed', 'awaiting_scores', 'scored', 'report_ready');--> statement-breakpoint
CREATE TYPE "public"."settlement_method" AS ENUM('stripe_connect', 'platform_invoice', 'manual');--> statement-breakpoint
CREATE SEQUENCE "public"."client_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."invoice_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."order_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_language" text DEFAULT 'en' NOT NULL,
	"available_languages" text[] DEFAULT '{"en"}' NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scoring_config" jsonb NOT NULL,
	"notification_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report_page_size_default" text DEFAULT 'a4' NOT NULL,
	"retail_enabled" boolean DEFAULT false NOT NULL,
	"retail_price" bigint,
	"retail_currency" char(3),
	"connected_stripe_account_id" text,
	"revenue_split_pct" numeric(5, 2),
	"royalty_policy" jsonb,
	"timezone" text DEFAULT 'Europe/Dublin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "questionnaire_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"variant" text DEFAULT 'self' NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_versions_product_id_version_variant_unique" UNIQUE("product_id","version","variant")
);
--> statement-breakpoint
CREATE TABLE "report_template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"component_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_template_versions_product_id_version_unique" UNIQUE("product_id","version")
);
--> statement-breakpoint
CREATE TABLE "translation_strings" (
	"product_id" uuid NOT NULL,
	"string_key" text NOT NULL,
	"language" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_strings_product_id_string_key_language_pk" PRIMARY KEY("product_id","string_key","language")
);
--> statement-breakpoint
CREATE TABLE "client_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'tag' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_groups_client_id_name_unique" UNIQUE("client_id","name")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_number" integer NOT NULL,
	"name" text NOT NULL,
	"is_platform_retail" boolean DEFAULT false NOT NULL,
	"billing_email" text,
	"billing_address" jsonb,
	"default_currency" char(3) DEFAULT 'EUR' NOT NULL,
	"xero_contact_id" text,
	"timezone" text DEFAULT 'Europe/Dublin' NOT NULL,
	"notification_overrides" jsonb,
	"source" text DEFAULT 'native' NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_client_number_unique" UNIQUE("client_number")
);
--> statement-breakpoint
CREATE TABLE "respondents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext",
	"first_name" text,
	"last_name" text,
	"user_id" text,
	"language" text,
	"source" text DEFAULT 'native' NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" "role_name" NOT NULL,
	"product_id" uuid,
	"client_id" uuid,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_user_id_role_product_id_client_id_unique" UNIQUE("user_id","role","product_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"max_respondents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_tokens_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "group_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "order_group_links" (
	"order_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "order_group_links_order_id_group_id_pk" PRIMARY KEY("order_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_items_order_id_line_no_unique" UNIQUE("order_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"type" "order_type" NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"client_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"report_template_version_id" uuid,
	"report_language" text DEFAULT 'en' NOT NULL,
	"report_model" "report_model" DEFAULT 'individual' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"payment_provider" "payment_provider",
	"entitlement_id" uuid,
	"notification_policy" jsonb,
	"suppress_notifications" boolean DEFAULT false NOT NULL,
	"expected_respondents" integer,
	"page_size" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"related_order_id" uuid,
	"placed_by_user_id" text,
	"placed_via" text DEFAULT 'admin' NOT NULL,
	"error_detail" jsonb,
	"source" text DEFAULT 'native' NOT NULL,
	"legacy_id" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "redemption_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"redeemed_session_id" uuid,
	"redeemed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "redemption_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "report_access_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "report_access_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"session_id" uuid,
	"template_version_id" uuid NOT NULL,
	"kind" text DEFAULT 'individual' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	"legacy_pdf_path" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "respondent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"respondent_id" uuid,
	"token" uuid NOT NULL,
	"pin_hash" text,
	"status" "session_status" DEFAULT 'created' NOT NULL,
	"is_focal" boolean DEFAULT true NOT NULL,
	"rater_relationship" text,
	"questionnaire_version_id" uuid NOT NULL,
	"language" text,
	"invited_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"reminders_suppressed" boolean DEFAULT false NOT NULL,
	"scores" jsonb,
	"scored_at" timestamp with time zone,
	"source" text DEFAULT 'native' NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "respondent_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "scoring_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"mode" "scoring_mode" NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"callback_token_hash" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"delta" integer NOT NULL,
	"order_id" uuid,
	"invoice_id" uuid,
	"note" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"plan_type" "plan_type" NOT NULL,
	"unit" text DEFAULT 'credit' NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"unit_price" bigint,
	"currency" char(3),
	"billing_cycle" text,
	"period_start" date,
	"period_end" date,
	"low_balance_threshold" integer DEFAULT 5,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_client_id_product_id_plan_type_unique" UNIQUE("client_id","product_id","plan_type")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" bigint NOT NULL,
	"tax" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"xero_invoice_id" text,
	"pushed_to_xero_at" timestamp with time zone,
	"due_date" date,
	"paid_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid,
	"invoice_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"method" text,
	"status" "payment_status" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"session_id" uuid,
	"basis" text NOT NULL,
	"basis_amount" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"period" text NOT NULL,
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"method" "settlement_method" NOT NULL,
	"total" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_by" text,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"client_id" uuid,
	"product_id" uuid,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"product_id" uuid NOT NULL,
	"client_id" uuid,
	"status" "domain_status" DEFAULT 'pending_dns' NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid,
	"session_id" uuid,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"template" text NOT NULL,
	"language" text,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"client_id" uuid,
	"product_id" uuid,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template_versions" ADD CONSTRAINT "report_template_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_strings" ADD CONSTRAINT "translation_strings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_tokens" ADD CONSTRAINT "group_tokens_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_group_links" ADD CONSTRAINT "order_group_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_group_links" ADD CONSTRAINT "order_group_links_group_id_client_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."client_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_report_template_version_id_report_template_versions_id_fk" FOREIGN KEY ("report_template_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_related_order_id_orders_id_fk" FOREIGN KEY ("related_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_codes" ADD CONSTRAINT "redemption_codes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_codes" ADD CONSTRAINT "redemption_codes_redeemed_session_id_respondent_sessions_id_fk" FOREIGN KEY ("redeemed_session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_access_links" ADD CONSTRAINT "report_access_links_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_session_id_respondent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_template_version_id_report_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "respondent_sessions" ADD CONSTRAINT "respondent_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "respondent_sessions" ADD CONSTRAINT "respondent_sessions_respondent_id_respondents_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."respondents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "respondent_sessions" ADD CONSTRAINT "respondent_sessions_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_jobs" ADD CONSTRAINT "scoring_jobs_session_id_respondent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_ledger" ADD CONSTRAINT "entitlement_ledger_entitlement_id_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_ledger" ADD CONSTRAINT "entitlement_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_ledger" ADD CONSTRAINT "royalty_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_ledger" ADD CONSTRAINT "royalty_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_ledger" ADD CONSTRAINT "royalty_ledger_session_id_respondent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."respondent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_settlements" ADD CONSTRAINT "royalty_settlements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "respondents_email_idx" ON "respondents" USING btree ("email");--> statement-breakpoint
CREATE INDEX "orders_client_idx" ON "orders" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "orders_product_idx" ON "orders" USING btree ("product_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sessions_order_idx" ON "respondent_sessions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "respondent_sessions" USING btree ("status","last_reminder_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");