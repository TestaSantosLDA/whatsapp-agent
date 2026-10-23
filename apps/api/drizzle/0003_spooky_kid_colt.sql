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
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "profiling_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "admin_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_passages" ADD CONSTRAINT "document_passages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_team_members_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "document_passages_document" ON "document_passages" USING btree ("document_id","page");--> statement-breakpoint
CREATE INDEX "document_passages_search" ON "document_passages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "documents_client" ON "documents" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_events_lead" ON "lead_events" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_notes_lead" ON "lead_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_audit_client_time" ON "privacy_audit" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_client_status" ON "privacy_requests" USING btree ("client_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_data_overrides_key" ON "product_data_overrides" USING btree ("client_id","product_key","field");--> statement-breakpoint
CREATE INDEX "product_data_proposals_document" ON "product_data_proposals" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_member_id_team_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_client_created" ON "leads" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_client_status" ON "leads" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "leads_owner" ON "leads" USING btree ("owner_member_id");