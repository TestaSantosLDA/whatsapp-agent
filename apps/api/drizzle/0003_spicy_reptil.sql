CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"author_member_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profile_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" jsonb,
	"source" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"conversation_id" uuid,
	"evidence" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text,
	"company" text,
	"nif" text,
	"role" text,
	"regions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"label" text,
	"text" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('portuguese', coalesce("document_passages"."label", '') || ' ' || "document_passages"."text"), 'A') || setweight(to_tsvector('simple', "document_passages"."text"), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"error" text,
	"uploaded_by" uuid,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_gap_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"topic" text NOT NULL,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"week_start" text NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"actor_member_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"author_member_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"actor_member_id" uuid,
	"action" text NOT NULL,
	"target_hash" text NOT NULL,
	"request_id" uuid,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"contact_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'whatsapp' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_data_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"product_key" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"document_id" uuid,
	"proposal_id" uuid,
	"approved_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_data_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer,
	"product_key" text,
	"product_label" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"edited_value" jsonb,
	"confidence" numeric(4, 3) NOT NULL,
	"quote" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_counters" (
	"client_id" text NOT NULL,
	"year" integer NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "quote_counters_client_id_year_pk" PRIMARY KEY("client_id","year")
);
--> statement-breakpoint
CREATE TABLE "quote_pdfs" (
	"quote_id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"filename" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"lead_id" uuid,
	"conversation_id" uuid,
	"contact_id" uuid,
	"branch_id" text,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount" jsonb,
	"valid_until" text NOT NULL,
	"fulfilment" text,
	"notes" text,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"sends" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public_token" text,
	"public_token_expires_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "profiling_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "branch_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_member_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "team_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "admin_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_member_id_team_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_updated_by_team_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_passages" ADD CONSTRAINT "document_passages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_team_members_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_gap_dismissals" ADD CONSTRAINT "insight_gap_dismissals_dismissed_by_team_members_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_actor_member_id_team_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_author_member_id_team_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_decided_by_team_members_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_overrides" ADD CONSTRAINT "product_data_overrides_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_overrides" ADD CONSTRAINT "product_data_overrides_proposal_id_product_data_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."product_data_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_overrides" ADD CONSTRAINT "product_data_overrides_approved_by_team_members_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_proposals" ADD CONSTRAINT "product_data_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_proposals" ADD CONSTRAINT "product_data_proposals_decided_by_team_members_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pdfs" ADD CONSTRAINT "quote_pdfs_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_team_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_updated_by_team_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notes_customer" ON "customer_notes" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profile_fields_field" ON "customer_profile_fields" USING btree ("customer_id","field");--> statement-breakpoint
CREATE INDEX "customers_client" ON "customers" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "document_passages_document" ON "document_passages" USING btree ("document_id","page");--> statement-breakpoint
CREATE INDEX "document_passages_search" ON "document_passages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "documents_client" ON "documents" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "insight_gap_dismissals_topic" ON "insight_gap_dismissals" USING btree ("client_id","topic");--> statement-breakpoint
CREATE UNIQUE INDEX "insight_reports_week" ON "insight_reports" USING btree ("client_id","week_start");--> statement-breakpoint
CREATE INDEX "lead_events_lead" ON "lead_events" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_notes_lead" ON "lead_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_audit_client_time" ON "privacy_audit" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_client_status" ON "privacy_requests" USING btree ("client_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_data_overrides_key" ON "product_data_overrides" USING btree ("client_id","product_key","field");--> statement-breakpoint
CREATE INDEX "product_data_proposals_document" ON "product_data_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_client_number" ON "quotes" USING btree ("client_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_public_token" ON "quotes" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "quotes_lead" ON "quotes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "quotes_contact" ON "quotes" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_member_id_team_members_id_fk" FOREIGN KEY ("assigned_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_member_id_team_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_member_id_team_members_id_fk" FOREIGN KEY ("sent_by_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_customer" ON "contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversations_client_activity" ON "conversations" USING btree ("client_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "leads_client_created" ON "leads" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_client_status" ON "leads" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "leads_owner" ON "leads" USING btree ("owner_member_id");
