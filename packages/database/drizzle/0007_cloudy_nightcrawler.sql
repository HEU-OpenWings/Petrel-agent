ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verify_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verify_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_email_verify_token_hash_idx" ON "users" USING btree ("email_verify_token_hash") WHERE "users"."email_verify_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_password_reset_token_hash_idx" ON "users" USING btree ("password_reset_token_hash") WHERE "users"."password_reset_token_hash" IS NOT NULL;--> statement-breakpoint
-- 存量账号视为已验证（回填为创建时间），避免老用户上线后被锁在门外
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
