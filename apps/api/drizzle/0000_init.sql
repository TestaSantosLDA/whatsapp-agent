CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6),
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"wa_id" text NOT NULL,
	"name" text,
	"language" text,
	"consent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'bot' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"type" text NOT NULL,
	"branch_id" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel_message_id" text NOT NULL,
	"type" text NOT NULL,
	"text" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"to" text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"sku" text,
	"title" text NOT NULL,
	"variant_title" text,
	"product_type" text,
	"vendor" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"description" text,
	"price" numeric(12, 2) NOT NULL,
	"compare_at_price" numeric(12, 2),
	"available" boolean NOT NULL,
	"url" text NOT NULL,
	"image_url" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('portuguese', coalesce("products"."title", '') || ' ' || coalesce("products"."variant_title", '')), 'A') || setweight(to_tsvector('portuguese', coalesce("products"."product_type", '') || ' ' || coalesce("products"."vendor", '')), 'B') || setweight(to_tsvector('portuguese', coalesce("products"."description", '')), 'C') || setweight(to_tsvector('simple', coalesce("products"."sku", '') || ' ' || coalesce("products"."vendor", '') || ' ' || coalesce("products"."title", '')), 'A')) STORED,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_client_wa_id" ON "contacts" USING btree ("client_id","wa_id");--> statement-breakpoint
CREATE INDEX "conversations_contact" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_per_contact" ON "conversations" USING btree ("contact_id") WHERE "conversations"."status" <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_channel_id" ON "messages" USING btree ("client_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_client_variant" ON "products" USING btree ("client_id","variant_id");--> statement-breakpoint
CREATE INDEX "products_search" ON "products" USING gin ("search_vector");