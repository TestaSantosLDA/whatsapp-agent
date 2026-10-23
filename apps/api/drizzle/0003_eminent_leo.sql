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
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "profiling_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_decided_by_team_members_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_audit_client_time" ON "privacy_audit" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_client_status" ON "privacy_requests" USING btree ("client_id","status","created_at");