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
	"created_by" uuid,
	"updated_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_pdfs" ADD CONSTRAINT "quote_pdfs_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_team_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_updated_by_team_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_client_number" ON "quotes" USING btree ("client_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_public_token" ON "quotes" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "quotes_lead" ON "quotes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "quotes_contact" ON "quotes" USING btree ("contact_id");