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
ALTER TABLE "contacts" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_member_id_team_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile_fields" ADD CONSTRAINT "customer_profile_fields_updated_by_team_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notes_customer" ON "customer_notes" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profile_fields_field" ON "customer_profile_fields" USING btree ("customer_id","field");--> statement-breakpoint
CREATE INDEX "customers_client" ON "customers" USING btree ("client_id","created_at");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_customer" ON "contacts" USING btree ("customer_id");