-- Owner Phase 2: regroup orphaned ledger rows into their journals.
--
-- Rows whose appointment was deleted lost their appointmentId (ON DELETE SET
-- NULL), so 20261011100001's backfill made each one its own journal and every
-- one of them read as unbalanced. Each set was written by one createMany, so
-- the rows of a set share a createdAt; those are one journal. (Checked before
-- shipping: 28 such groups, every one sums to zero.) From now on journalId
-- survives the appointment's deletion, so this is a one-off.

UPDATE "ledger_entries"
SET "journalId" = 'orphan-' || md5("createdAt"::text)
WHERE "appointmentId" IS NULL AND "journalId" = "id";
