CREATE TABLE "user_provider_credentials" (
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_hint" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_credentials_user_id_provider_id_pk" PRIMARY KEY("user_id","provider_id"),
	CONSTRAINT "user_provider_credentials_format_check" CHECK ("user_provider_credentials"."format_version" = 1),
	CONSTRAINT "user_provider_credentials_revision_check" CHECK ("user_provider_credentials"."revision" > 0),
	CONSTRAINT "user_provider_credentials_key_id_check" CHECK ("user_provider_credentials"."key_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "user_provider_credentials_nonce_check" CHECK ("user_provider_credentials"."nonce" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "user_provider_credentials_ciphertext_check" CHECK ("user_provider_credentials"."ciphertext" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "user_provider_credentials_auth_tag_check" CHECK ("user_provider_credentials"."auth_tag" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "user_provider_credentials_key_hint_check" CHECK (length("user_provider_credentials"."key_hint") BETWEEN 1 AND 4 AND "user_provider_credentials"."key_hint" ~ '^[\x21-\x7E]+$'),
	CONSTRAINT "user_provider_credentials_provider_id_check" CHECK (length("user_provider_credentials"."provider_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "user_provider_credentials" ADD CONSTRAINT "user_provider_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;