CREATE TABLE "client_settings" (
	"client_id" text PRIMARY KEY NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"branches" text[] DEFAULT '{}' NOT NULL,
	"invited_by" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_settings" ADD CONSTRAINT "client_settings_updated_by_team_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_client_email" ON "team_members" USING btree ("client_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_client_user" ON "team_members" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "team_members_user" ON "team_members" USING btree ("user_id");