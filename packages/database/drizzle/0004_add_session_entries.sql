CREATE TABLE "session_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_id" uuid,
	"entry_seq" bigserial NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_entries_session_seq_idx" ON "session_entries" USING btree ("session_id","entry_seq");--> statement-breakpoint
CREATE INDEX "session_entries_session_type_idx" ON "session_entries" USING btree ("session_id","type");