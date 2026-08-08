CREATE TABLE "token_usage" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"model" text,
	"provider" text,
	"api" text,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cost_total" numeric(20, 12) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_usage_total_check" CHECK ("token_usage"."total_tokens" = "token_usage"."input_tokens" + "token_usage"."output_tokens" + "token_usage"."cache_read_tokens" + "token_usage"."cache_write_tokens")
);
--> statement-breakpoint
CREATE TABLE "user_quota_limits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token_limit" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quota_limits" ADD CONSTRAINT "user_quota_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_usage_user_recorded_idx" ON "token_usage" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE INDEX "token_usage_recorded_idx" ON "token_usage" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "token_usage_session_recorded_idx" ON "token_usage" USING btree ("session_id","recorded_at");