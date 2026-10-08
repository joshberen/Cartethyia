-- Existing databases may still have the enroll-only check; personal keys need handoff links.
--
-- Databases written by the previous share vocabulary carry `monitor` (the
-- durable public page) and `setup` (the one-time credential handoff) rows. The
-- check below only admits the current names, so those rows must be renamed
-- first or the constraint fails and the whole upgrade stops mid-chain.
--
-- `monitor` renames to `enroll` (both serve the public policy page) and `setup`
-- to `handoff` (both reveal the key once). Every renamed row is also retired,
-- matching the rule the backup importer already applies to the same two legacy
-- kinds ("import them as inactive enrollment links so their old tokens never
-- regain a usable public endpoint", `src/console/backup/validate.ts`): the old
-- rows were written for the old page contract, and an old token must not start
-- answering the new one. The rows stay for audit; only their tokens stop
-- resolving.
UPDATE "public"."share_links"
  SET "kind" = 'enroll', "active" = false WHERE "kind" = 'monitor';
UPDATE "public"."share_links"
  SET "kind" = 'handoff', "active" = false WHERE "kind" = 'setup';
ALTER TABLE "public"."share_links"
  DROP CONSTRAINT IF EXISTS "share_links_kind_check";
ALTER TABLE "public"."share_links"
  ADD CONSTRAINT "share_links_kind_check"
  CHECK ("kind" IN ('enroll', 'handoff'));
