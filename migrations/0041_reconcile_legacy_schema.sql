-- Reconcile databases built from the pre-rewrite baseline snapshot.
--
-- `0000_baseline.sql` is a snapshot of the schema, and the numbered files after
-- it carry only the delta *between* snapshots. Objects that were introduced by
-- editing the baseline itself therefore reach no existing database: it already
-- has `0000_baseline.sql` in its ledger, so the snapshot never runs again, and
-- no later file adds them. A database created before the rewrite finishes the
-- whole chain while still missing `telemetry_usage_totals` and the share-key
-- columns on `api_keys`, and the gateway then fails on its first key lookup
-- (`column "key_mode" does not exist`).
--
-- This migration closes that gap. Every statement is idempotent, so it is a
-- no-op on databases created from the current baseline.
--
-- Legacy objects that the current baseline no longer declares (`backup_status`,
-- `console_users.last_login_at`, `telemetry_payloads.redaction_applied`, and
-- four superseded indexes) are deliberately left in place: they are unused by
-- the current code and therefore harmless, and dropping them is a destructive
-- change that does not belong in the migration that unblocks the upgrade.

-- 1. telemetry_usage_totals — absent entirely from pre-rewrite databases.
CREATE TABLE IF NOT EXISTS "public"."telemetry_usage_totals" (
  "tenant_id" uuid NOT NULL,
  "identity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "requests" bigint DEFAULT 0 NOT NULL,
  "errors" bigint DEFAULT 0 NOT NULL,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "last_used_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "telemetry_usage_totals_identity_type_check"
    CHECK ("identity_type" IN ('account', 'api_key'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telemetry_usage_totals_identity_pk'
      AND conrelid = 'public.telemetry_usage_totals'::regclass
  ) THEN
    ALTER TABLE "public"."telemetry_usage_totals"
      ADD CONSTRAINT "telemetry_usage_totals_identity_pk"
      PRIMARY KEY ("tenant_id", "identity_type", "entity_id");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telemetry_usage_totals_tenant_id_tenants_id_fk'
      AND conrelid = 'public.telemetry_usage_totals'::regclass
  ) THEN
    ALTER TABLE "public"."telemetry_usage_totals"
      ADD CONSTRAINT "telemetry_usage_totals_tenant_id_tenants_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint

-- 2. api_keys — the share-key shape (`key_mode`, parent/issued columns) exists
-- only in the rewritten baseline. `key_hash` becomes nullable because a share
-- template key carries no credential of its own; existing rows all hold a hash,
-- so they satisfy the `personal` branch of the constraint added below.
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "key_mode" text DEFAULT 'personal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "parent_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "issued_client_ip" text;
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "issued_client_ip_key" text;
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ALTER COLUMN "key_hash" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_mode_shape_check'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE "public"."api_keys"
      ADD CONSTRAINT "api_keys_mode_shape_check" CHECK (
        (
          ("key_mode" = 'personal')
          AND ("key_hash" IS NOT NULL)
          AND ("parent_key_id" IS NULL)
          AND ("issued_client_ip" IS NULL)
          AND ("issued_client_ip_key" IS NULL)
        )
        OR (
          ("key_mode" = 'share')
          AND (
            (
              ("parent_key_id" IS NULL)
              AND ("key_hash" IS NULL)
              AND ("key_encrypted" IS NULL)
              AND ("issued_client_ip" IS NULL)
              AND ("issued_client_ip_key" IS NULL)
            )
            OR (
              ("parent_key_id" IS NOT NULL)
              AND ("key_hash" IS NOT NULL)
              AND ("key_encrypted" IS NULL)
              AND ("issued_client_ip" IS NOT NULL)
              AND ("issued_client_ip_key" IS NOT NULL)
            )
          )
        )
      );
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_parent_key_id_api_keys_id_fk'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE "public"."api_keys"
      ADD CONSTRAINT "api_keys_parent_key_id_api_keys_id_fk"
      FOREIGN KEY ("parent_key_id") REFERENCES "public"."api_keys"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_parent_key_id_idx"
  ON "public"."api_keys" USING btree ("parent_key_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_active_shared_ip_uidx"
  ON "public"."api_keys" USING btree ("issued_client_ip_key")
  WHERE ("parent_key_id" IS NOT NULL AND "revoked_at" IS NULL);
--> statement-breakpoint

-- 3. share_links — `token_encrypted` and the current kind default. Existing
-- kind values were already normalized by 0006, which runs before this file.
ALTER TABLE "public"."share_links"
  ADD COLUMN IF NOT EXISTS "token_encrypted" bytea;
--> statement-breakpoint
ALTER TABLE "public"."share_links"
  ALTER COLUMN "kind" SET DEFAULT 'enroll';
--> statement-breakpoint

-- 4. telemetry_events — the tenant/account listing index from the baseline.
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_account_created_idx"
  ON "public"."telemetry_events" USING btree ("tenant_id", "account_id", "created_at");
