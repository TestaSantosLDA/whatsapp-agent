ALTER TABLE "conversations" ADD COLUMN "branch_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_member_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "team_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_member_id_team_members_id_fk" FOREIGN KEY ("assigned_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_member_id_team_members_id_fk" FOREIGN KEY ("sent_by_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_client_activity" ON "conversations" USING btree ("client_id","last_activity_at");