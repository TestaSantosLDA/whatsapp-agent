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
ALTER TABLE "insight_gap_dismissals" ADD CONSTRAINT "insight_gap_dismissals_dismissed_by_team_members_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insight_gap_dismissals_topic" ON "insight_gap_dismissals" USING btree ("client_id","topic");--> statement-breakpoint
CREATE UNIQUE INDEX "insight_reports_week" ON "insight_reports" USING btree ("client_id","week_start");