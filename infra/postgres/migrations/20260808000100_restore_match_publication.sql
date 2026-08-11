-- migrate:up

-- Restores the on-chain match-result publication pipeline dropped by
-- 20260801000100_local_match_results.sql. The manager rejected the DB-only
-- approach (PR #11): the card requires the canonical match summary to be
-- broadcast to Hive and re-read via HAF. The embedded canonical_complete_result
-- bytea column added by the removal migration is kept as-is; only the
-- outbox/projection pipeline and its role are re-created here, verbatim from
-- the objects the removal migration dropped.

-- Enums
CREATE TYPE "game"."match_publication_request_type" AS ENUM (
  'initial',
  'correction',
  'invalidation'
);

CREATE TYPE "game"."match_publication_request_state" AS ENUM (
  'queued',
  'batched',
  'published',
  'retryable_failed',
  'cancelled'
);

CREATE TYPE "game"."match_publication_outbox_state" AS ENUM (
  'queued',
  'broadcast',
  'included',
  'irreversible',
  'reverted',
  'retryable_failed',
  'terminal_failed'
);

CREATE TYPE "hive_projection"."match_event_type" AS ENUM (
  'match_results_batch',
  'match_result_corrected',
  'match_result_invalidated'
);

CREATE TYPE "hive_projection"."match_result_current_state" AS ENUM (
  'current',
  'corrected',
  'invalidated'
);

CREATE TYPE "hive_projection"."match_change_type" AS ENUM (
  'correction',
  'invalidation'
);

-- Tables
CREATE TABLE "game"."match_publication_request" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_id" uuid NOT NULL,
  "result_revision_id" uuid UNIQUE NOT NULL,
  "request_type" game.match_publication_request_type NOT NULL,
  "state" game.match_publication_request_state NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_failure_code" varchar(64),
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_publication_request_attempts" CHECK (attempt_count >= 0),
  CONSTRAINT "chk_match_publication_request_published" CHECK ((state <> 'published') OR published_at IS NOT NULL)
);

CREATE TABLE "game"."match_publication_outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "event_uuid" uuid UNIQUE NOT NULL,
  "batch_uuid" uuid UNIQUE,
  "event_type" hive_projection.match_event_type NOT NULL,
  "schema_version" smallint NOT NULL,
  "event_contract_version" varchar(32) NOT NULL,
  "publication_period_start" timestamptz,
  "publication_period_end" timestamptz,
  "publisher_hive_account" varchar(16) NOT NULL,
  "result_count" smallint NOT NULL,
  "canonical_payload" text NOT NULL,
  "parsed_payload" jsonb NOT NULL,
  "payload_sha256" char(64) NOT NULL,
  "payload_byte_count" integer NOT NULL,
  "state" game.match_publication_outbox_state NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_failure_code" varchar(64),
  "hive_transaction_id" varchar(128),
  "operation_id" uuid UNIQUE,
  "included_at" timestamptz,
  "irreversible_at" timestamptz,
  "reverted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_outbox_schema_version" CHECK (schema_version > 0),
  CONSTRAINT "chk_match_outbox_event_shape" CHECK ((event_type = 'match_results_batch' AND batch_uuid IS NOT NULL AND publication_period_start IS NOT NULL AND publication_period_end IS NOT NULL AND publication_period_end >= publication_period_start) OR (event_type <> 'match_results_batch' AND batch_uuid IS NULL AND publication_period_start IS NULL AND publication_period_end IS NULL AND result_count = 1)),
  CONSTRAINT "chk_match_outbox_publisher_lower" CHECK (publisher_hive_account = lower(publisher_hive_account)),
  CONSTRAINT "chk_match_outbox_result_count" CHECK (result_count > 0),
  CONSTRAINT "chk_match_outbox_payload_size" CHECK (payload_byte_count > 0 AND octet_length(canonical_payload) = payload_byte_count),
  CONSTRAINT "chk_match_outbox_attempts" CHECK (attempt_count >= 0),
  CONSTRAINT "chk_match_outbox_included" CHECK ((state <> 'included') OR (hive_transaction_id IS NOT NULL AND operation_id IS NOT NULL AND included_at IS NOT NULL)),
  CONSTRAINT "chk_match_outbox_irreversible" CHECK ((state <> 'irreversible') OR (operation_id IS NOT NULL AND irreversible_at IS NOT NULL)),
  CONSTRAINT "chk_match_outbox_reverted" CHECK ((state <> 'reverted') OR (operation_id IS NOT NULL AND reverted_at IS NOT NULL))
);

CREATE TABLE "game"."match_publication_item" (
  "id" uuid PRIMARY KEY NOT NULL,
  "outbox_id" uuid NOT NULL,
  "publication_request_id" uuid UNIQUE NOT NULL,
  "round_id" uuid NOT NULL,
  "result_revision_id" uuid NOT NULL,
  "result_position" smallint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_publication_item_position" CHECK (result_position >= 0)
);

CREATE TABLE "hive_projection"."match_event" (
  "event_uuid" uuid PRIMARY KEY NOT NULL,
  "batch_uuid" uuid UNIQUE,
  "operation_id" uuid UNIQUE NOT NULL,
  "event_type" hive_projection.match_event_type NOT NULL,
  "schema_version" smallint NOT NULL,
  "event_contract_version" varchar(32) NOT NULL,
  "publication_period_start" timestamptz,
  "publication_period_end" timestamptz,
  "publisher_hive_account" varchar(16) NOT NULL,
  "result_count" smallint NOT NULL,
  "operation_state" hive_projection.operation_state NOT NULL,
  "validation_state" hive_projection.validation_state NOT NULL DEFAULT 'pending',
  "rejection_reason" varchar(128),
  "included_at" timestamptz NOT NULL,
  "irreversible_at" timestamptz,
  "reverted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_event_schema_version" CHECK (schema_version > 0),
  CONSTRAINT "chk_match_event_shape" CHECK ((event_type = 'match_results_batch' AND batch_uuid IS NOT NULL AND publication_period_start IS NOT NULL AND publication_period_end IS NOT NULL AND publication_period_end >= publication_period_start) OR (event_type <> 'match_results_batch' AND batch_uuid IS NULL AND publication_period_start IS NULL AND publication_period_end IS NULL AND result_count = 1)),
  CONSTRAINT "chk_match_event_publisher_lower" CHECK (publisher_hive_account = lower(publisher_hive_account)),
  CONSTRAINT "chk_match_event_result_count" CHECK (result_count > 0),
  CONSTRAINT "chk_match_event_change_count" CHECK ((event_type = 'match_results_batch') OR result_count = 1),
  CONSTRAINT "chk_match_event_irreversible" CHECK ((operation_state <> 'irreversible') OR irreversible_at IS NOT NULL),
  CONSTRAINT "chk_match_event_reverted" CHECK ((operation_state <> 'reverted') OR reverted_at IS NOT NULL),
  CONSTRAINT "chk_match_event_rejection" CHECK ((validation_state <> 'rejected') OR rejection_reason IS NOT NULL),
  CONSTRAINT "chk_match_event_state_evidence" CHECK ((operation_state = 'included' AND irreversible_at IS NULL AND reverted_at IS NULL) OR (operation_state = 'irreversible' AND irreversible_at IS NOT NULL AND reverted_at IS NULL) OR (operation_state = 'reverted' AND irreversible_at IS NULL AND reverted_at IS NOT NULL)),
  CONSTRAINT "chk_match_event_validation_state" CHECK ((operation_state = 'reverted' AND validation_state = 'reverted' AND rejection_reason IS NULL) OR (operation_state <> 'reverted' AND validation_state = 'accepted' AND rejection_reason IS NULL))
);

CREATE TABLE "hive_projection"."match_result" (
  "id" uuid PRIMARY KEY NOT NULL,
  "initial_event_uuid" uuid NOT NULL,
  "result_position" smallint NOT NULL,
  "round_id" uuid UNIQUE NOT NULL,
  "result_schema_version" varchar(32) NOT NULL,
  "scoring_rule_version" varchar(32) NOT NULL,
  "map_version_id" uuid NOT NULL,
  "map_content_sha256" char(64) NOT NULL,
  "server_build_version" varchar(64) NOT NULL,
  "match_protocol_version" varchar(32) NOT NULL,
  "public_result_sha256" char(64) NOT NULL,
  "current_state" hive_projection.match_result_current_state NOT NULL DEFAULT 'current',
  "current_event_uuid" uuid NOT NULL,
  "matched_result_revision_id" uuid,
  "reconciliation_state" hive_projection.reconciliation_state NOT NULL DEFAULT 'pending',
  "reconciled_at" timestamptz,
  "divergence_detected_at" timestamptz,
  "divergence_reason_code" varchar(64),
  "incident_reference" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_result_position" CHECK (result_position >= 0),
  CONSTRAINT "chk_match_result_matched" CHECK ((reconciliation_state <> 'matched') OR (matched_result_revision_id IS NOT NULL AND reconciled_at IS NOT NULL)),
  CONSTRAINT "chk_match_result_divergent" CHECK ((reconciliation_state <> 'divergent') OR (divergence_detected_at IS NOT NULL AND divergence_reason_code IS NOT NULL))
);

CREATE TABLE "hive_projection"."match_result_change" (
  "event_uuid" uuid PRIMARY KEY NOT NULL,
  "projected_result_id" uuid NOT NULL,
  "round_id" uuid NOT NULL,
  "original_batch_uuid" uuid NOT NULL,
  "original_event_uuid" uuid NOT NULL,
  "supersedes_event_uuid" uuid NOT NULL,
  "change_type" hive_projection.match_change_type NOT NULL,
  "reason_code" varchar(64) NOT NULL,
  "replacement_result_revision_id" uuid,
  "replacement_result_schema_version" varchar(32),
  "replacement_scoring_rule_version" varchar(32),
  "replacement_map_version_id" uuid,
  "replacement_map_content_sha256" char(64),
  "replacement_server_build_version" varchar(64),
  "replacement_match_protocol_version" varchar(32),
  "replacement_public_result_sha256" char(64),
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_match_result_change_correction" CHECK ((change_type <> 'correction') OR (replacement_result_revision_id IS NOT NULL AND replacement_result_schema_version IS NOT NULL AND replacement_scoring_rule_version IS NOT NULL AND replacement_map_version_id IS NOT NULL AND replacement_map_content_sha256 IS NOT NULL AND replacement_server_build_version IS NOT NULL AND replacement_match_protocol_version IS NOT NULL AND replacement_public_result_sha256 IS NOT NULL)),
  CONSTRAINT "chk_match_result_change_invalidation" CHECK ((change_type <> 'invalidation') OR (replacement_result_revision_id IS NULL AND replacement_result_schema_version IS NULL AND replacement_scoring_rule_version IS NULL AND replacement_map_version_id IS NULL AND replacement_map_content_sha256 IS NULL AND replacement_server_build_version IS NULL AND replacement_match_protocol_version IS NULL AND replacement_public_result_sha256 IS NULL))
);

-- UUIDv7 enforcement on single-column uuid primary keys (mirrors the
-- blanket loop in 20260716000200_postgresql_invariants.sql, which only ran
-- against tables that existed at that migration's original execution time)
ALTER TABLE game.match_publication_request
  ADD CONSTRAINT chk_match_publication_request_id_uuid_v7 CHECK (public.hc_is_uuid_v7(id));
ALTER TABLE game.match_publication_outbox
  ADD CONSTRAINT chk_match_publication_outbox_id_uuid_v7 CHECK (public.hc_is_uuid_v7(id));
ALTER TABLE game.match_publication_item
  ADD CONSTRAINT chk_match_publication_item_id_uuid_v7 CHECK (public.hc_is_uuid_v7(id));
ALTER TABLE hive_projection.match_event
  ADD CONSTRAINT chk_match_event_event_uuid_uuid_v7 CHECK (public.hc_is_uuid_v7(event_uuid));
ALTER TABLE hive_projection.match_result
  ADD CONSTRAINT chk_match_result_id_uuid_v7 CHECK (public.hc_is_uuid_v7(id));
ALTER TABLE hive_projection.match_result_change
  ADD CONSTRAINT chk_match_result_change_event_uuid_uuid_v7 CHECK (public.hc_is_uuid_v7(event_uuid));

-- SHA-256 hex-encoding enforcement (mirrors the blanket %sha256 loop in
-- 20260716000200_postgresql_invariants.sql for the same reason as above)
ALTER TABLE game.match_publication_outbox
  ADD CONSTRAINT chk_match_publication_outbox_payload_sha256_hex
  CHECK (payload_sha256 IS NULL OR public.hc_is_sha256(payload_sha256::text));
ALTER TABLE hive_projection.match_result
  ADD CONSTRAINT chk_match_result_map_content_sha256_hex
  CHECK (map_content_sha256 IS NULL OR public.hc_is_sha256(map_content_sha256::text));
ALTER TABLE hive_projection.match_result
  ADD CONSTRAINT chk_match_result_public_result_sha256_hex
  CHECK (public_result_sha256 IS NULL OR public.hc_is_sha256(public_result_sha256::text));
ALTER TABLE hive_projection.match_result_change
  ADD CONSTRAINT chk_match_result_change_replacement_map_content_sha256_hex
  CHECK (replacement_map_content_sha256 IS NULL OR public.hc_is_sha256(replacement_map_content_sha256::text));
ALTER TABLE hive_projection.match_result_change
  ADD CONSTRAINT chk_match_result_change_replacement_public_result_sha256_hex
  CHECK (replacement_public_result_sha256 IS NULL OR public.hc_is_sha256(replacement_public_result_sha256::text));

-- Invariant constraint and partial index
ALTER TABLE game.match_publication_outbox
  ADD CONSTRAINT chk_match_outbox_payload_sha256
  CHECK (
    encode(digest(convert_to(canonical_payload, 'UTF8'), 'sha256'), 'hex') = payload_sha256
  );

CREATE UNIQUE INDEX uq_match_publication_one_initial_round
    ON game.match_publication_request (round_id)
    WHERE request_type = 'initial'::game.match_publication_request_type
      AND state <> 'cancelled'::game.match_publication_request_state;

-- Indexes
CREATE INDEX "idx_match_publication_request_retry" ON "game"."match_publication_request" ("state", "next_retry_at");

CREATE INDEX "idx_match_publication_request_round" ON "game"."match_publication_request" ("round_id", "request_type", "state");

CREATE INDEX "idx_match_outbox_retry" ON "game"."match_publication_outbox" ("state", "next_retry_at");

CREATE INDEX "idx_match_outbox_event_type" ON "game"."match_publication_outbox" ("event_type", "created_at");

CREATE INDEX "idx_match_outbox_publisher" ON "game"."match_publication_outbox" ("publisher_hive_account", "state");

CREATE INDEX "idx_match_outbox_transaction" ON "game"."match_publication_outbox" ("hive_transaction_id");

CREATE UNIQUE INDEX "uq_match_publication_item_position" ON "game"."match_publication_item" ("outbox_id", "result_position");

CREATE INDEX "idx_match_publication_item_revision" ON "game"."match_publication_item" ("result_revision_id", "round_id");

CREATE INDEX "idx_match_publication_item_round" ON "game"."match_publication_item" ("round_id", "outbox_id");

CREATE INDEX "idx_match_event_publisher" ON "hive_projection"."match_event" ("publisher_hive_account", "included_at");

CREATE INDEX "idx_match_event_state" ON "hive_projection"."match_event" ("event_type", "operation_state", "included_at");

CREATE INDEX "idx_match_event_validation" ON "hive_projection"."match_event" ("validation_state", "created_at");

CREATE UNIQUE INDEX "uq_match_result_event_position" ON "hive_projection"."match_result" ("initial_event_uuid", "result_position");

CREATE UNIQUE INDEX "uq_match_result_round_identity" ON "hive_projection"."match_result" ("id", "round_id");

CREATE INDEX "idx_match_result_map_version" ON "hive_projection"."match_result" ("map_version_id", "created_at");

CREATE INDEX "idx_match_result_current_event" ON "hive_projection"."match_result" ("current_event_uuid", "current_state");

CREATE INDEX "idx_match_result_reconciliation" ON "hive_projection"."match_result" ("reconciliation_state", "created_at");

CREATE INDEX "idx_match_result_local_revision" ON "hive_projection"."match_result" ("matched_result_revision_id");

CREATE UNIQUE INDEX "uq_match_result_change_linear" ON "hive_projection"."match_result_change" ("round_id", "supersedes_event_uuid");

CREATE INDEX "idx_match_result_change_result_round" ON "hive_projection"."match_result_change" ("projected_result_id", "round_id");

CREATE INDEX "idx_match_result_change_history" ON "hive_projection"."match_result_change" ("projected_result_id", "created_at");

CREATE INDEX "idx_match_result_change_original_batch" ON "hive_projection"."match_result_change" ("original_batch_uuid");

CREATE INDEX "idx_match_result_change_original_event" ON "hive_projection"."match_result_change" ("original_event_uuid");

CREATE INDEX "idx_match_result_change_supersedes" ON "hive_projection"."match_result_change" ("supersedes_event_uuid");

CREATE INDEX "idx_match_result_change_revision" ON "hive_projection"."match_result_change" ("replacement_result_revision_id");

CREATE INDEX "idx_match_result_change_map_version" ON "hive_projection"."match_result_change" ("replacement_map_version_id");

-- Comments
COMMENT ON TABLE "game"."match_publication_request" IS 'The initial request is inserted in the same database transaction as the completed round, detailed rows, and initial result revision. Migration enforces type agreement with the revision and one noncancelled initial request per round.';

COMMENT ON COLUMN "game"."match_publication_request"."id" IS 'Application-generated UUIDv7; stable publication request';

COMMENT ON TABLE "game"."match_publication_outbox" IS 'Operational outbox, not the HAF projection. canonical_payload is the exact immutable application payload used across retries; parsed_payload is validated query data. Initial events carry a stable batch UUID and period; correction/invalidation events are single-result events and carry their original-batch lineage inside the event payload/change projection. Initial batching defaults to five minutes, 20 results, or 6 KiB, whichever is reached first; only production tuning is open. A retry may rebuild transaction headers but not logical IDs or payload bytes/hash.';

COMMENT ON COLUMN "game"."match_publication_outbox"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "game"."match_publication_outbox"."event_uuid" IS 'Stable protocol UUIDv7 across retries';

COMMENT ON COLUMN "game"."match_publication_outbox"."batch_uuid" IS 'Stable logical batch UUIDv7 across retries; initial batches only';

COMMENT ON TABLE "game"."match_publication_item" IS 'Links durable requests to one immutable payload. Migrations verify request/revision/round/type consistency, enforce one item for correction/invalidation events, and enforce item count/positions against outbox.result_count.';

COMMENT ON COLUMN "game"."match_publication_item"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."match_event" IS 'Normalized HAF-derived event root. Initial batch events carry batch/period fields; correction and invalidation lineage is stored in match_result_change. Full validated payload remains on operation.payload. Projector state follows the referenced operation through inclusion, fork rollback, replay, and irreversibility; only allow-listed publisher events are accepted.';

COMMENT ON COLUMN "hive_projection"."match_event"."event_uuid" IS 'Stable protocol UUIDv7';

COMMENT ON COLUMN "hive_projection"."match_event"."batch_uuid" IS 'Stable logical batch UUIDv7; initial batches only';

COMMENT ON TABLE "hive_projection"."match_result" IS 'Integrity/join cache of an accepted initial Hive summary. Detailed participants, discoveries, and likes remain authoritative in game tables. One accepted initial result per round is enforced; current_event_uuid advances linearly only under projector rules, while the original event remains queryable.';

COMMENT ON COLUMN "hive_projection"."match_result"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."match_result_change" IS 'Append-only correction/invalidation projection. The unique supersedes edge prevents branching; projector triggers require original_event_uuid to be the initial batch and event_uuid to have the matching event type. Replacement public summary detail remains in the validated operation payload.';

COMMENT ON COLUMN "hive_projection"."match_result_change"."event_uuid" IS 'Correction/invalidation protocol UUIDv7';

-- Foreign keys
ALTER TABLE "game"."match_publication_request" ADD CONSTRAINT "fk_match_publication_request_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_request" ADD CONSTRAINT "fk_match_publication_request_revision" FOREIGN KEY ("result_revision_id") REFERENCES "game"."round_result_revision" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_outbox" ADD CONSTRAINT "fk_match_outbox_operation" FOREIGN KEY ("operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_outbox" FOREIGN KEY ("outbox_id") REFERENCES "game"."match_publication_outbox" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_request" FOREIGN KEY ("publication_request_id") REFERENCES "game"."match_publication_request" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_revision" FOREIGN KEY ("result_revision_id", "round_id") REFERENCES "game"."round_result_revision" ("id", "round_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_event" ADD CONSTRAINT "fk_match_event_operation" FOREIGN KEY ("operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result" ADD CONSTRAINT "fk_match_result_initial_event" FOREIGN KEY ("initial_event_uuid") REFERENCES "hive_projection"."match_event" ("event_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result" ADD CONSTRAINT "fk_match_result_current_event" FOREIGN KEY ("current_event_uuid") REFERENCES "hive_projection"."match_event" ("event_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result" ADD CONSTRAINT "fk_match_result_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result" ADD CONSTRAINT "fk_match_result_map_version" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result" ADD CONSTRAINT "fk_match_result_revision" FOREIGN KEY ("matched_result_revision_id") REFERENCES "game"."round_result_revision" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_event" FOREIGN KEY ("event_uuid") REFERENCES "hive_projection"."match_event" ("event_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_result" FOREIGN KEY ("projected_result_id", "round_id") REFERENCES "hive_projection"."match_result" ("id", "round_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_original_batch" FOREIGN KEY ("original_batch_uuid") REFERENCES "hive_projection"."match_event" ("batch_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_original_event" FOREIGN KEY ("original_event_uuid") REFERENCES "hive_projection"."match_event" ("event_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_supersedes_event" FOREIGN KEY ("supersedes_event_uuid") REFERENCES "hive_projection"."match_event" ("event_uuid") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_revision" FOREIGN KEY ("replacement_result_revision_id") REFERENCES "game"."round_result_revision" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."match_result_change" ADD CONSTRAINT "fk_match_change_map_version" FOREIGN KEY ("replacement_map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- Domain-integrity triggers and functions
-- append-only match_result_change
CREATE TRIGGER trg_match_result_change_append_only
  BEFORE UPDATE OR DELETE ON hive_projection.match_result_change
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

-- publication request validation
CREATE OR REPLACE FUNCTION game.hc_validate_publication_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_row game.round_result_revision%ROWTYPE;
  round_status game.round_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO round_status
      FROM game.game_round
     WHERE id = OLD.round_id;

    IF round_status IN ('completed', 'aborted') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal round publication requests are retained';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO revision_row
    FROM game.round_result_revision
   WHERE id = NEW.result_revision_id;

  IF NOT FOUND
     OR revision_row.round_id <> NEW.round_id
     OR revision_row.revision_type::text <> NEW.request_type::text THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication request must match its round and revision type';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.round_id <> OLD.round_id
    OR NEW.result_revision_id <> OLD.result_revision_id
     OR NEW.request_type <> OLD.request_type
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'publication request identity is immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.request_type = 'initial'
     AND NEW.state = 'cancelled'
     AND OLD.state <> 'cancelled' THEN
    SELECT status INTO round_status
      FROM game.game_round
     WHERE id = NEW.round_id;
    IF round_status = 'completed' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'completed round must retain a noncancelled initial request';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_publication_request_validate
  BEFORE INSERT OR UPDATE OR DELETE ON game.match_publication_request
  FOR EACH ROW EXECUTE FUNCTION game.hc_validate_publication_request();

-- publication request round-state check
CREATE OR REPLACE FUNCTION game.hc_check_publication_request_round_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  round_status game.round_status;
BEGIN
  SELECT status INTO round_status
    FROM game.game_round
   WHERE id = NEW.round_id;

  IF NEW.state <> 'cancelled' AND round_status <> 'completed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active publication request requires a completed round at commit';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_match_publication_request_round_state
  AFTER INSERT OR UPDATE ON game.match_publication_request
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_publication_request_round_state();

-- terminal round bundle now also requires a noncancelled initial publication request
CREATE OR REPLACE FUNCTION game.hc_check_terminal_round_bundle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  participant_count integer;
  initial_hunter_count integer;
  initial_revision_count integer;
  initial_request_count integer;
BEGIN
  IF NEW.status = 'completed' THEN
    SELECT count(*), count(*) FILTER (WHERE initial_role = 'hunter')
      INTO participant_count, initial_hunter_count
      FROM game.round_participant
     WHERE round_id = NEW.id;

    SELECT count(*) INTO initial_revision_count
      FROM game.round_result_revision
     WHERE round_id = NEW.id AND revision_type = 'initial';

    SELECT count(*) INTO initial_request_count
      FROM game.match_publication_request
     WHERE round_id = NEW.id
       AND request_type = 'initial'
       AND state <> 'cancelled';

    IF participant_count < 2
       OR initial_hunter_count <> NEW.hunter_count
       OR participant_count <= NEW.hunter_count
       OR initial_revision_count <> 1
       OR initial_request_count <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'completed round has an incomplete terminal bundle';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM game.round_participant participant
       WHERE participant.round_id = NEW.id
         AND NOT EXISTS (
           SELECT 1
             FROM game.lobby_membership membership
            WHERE membership.lobby_id = NEW.lobby_id
              AND membership.player_id = participant.player_id
              AND membership.joined_at <= NEW.started_at
              AND (membership.left_at IS NULL OR membership.left_at >= NEW.started_at)
         )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'round participant did not belong to the lobby lifecycle';
    END IF;
  ELSIF NEW.status = 'aborted' THEN
    IF EXISTS (SELECT 1 FROM game.round_participant WHERE round_id = NEW.id)
       OR EXISTS (SELECT 1 FROM game.round_result_revision WHERE round_id = NEW.id)
       OR EXISTS (SELECT 1 FROM game.match_publication_request WHERE round_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'aborted round must not contain terminal result rows';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- outbox payload freeze
CREATE OR REPLACE FUNCTION game.hc_freeze_match_outbox_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_stable jsonb;
  new_stable jsonb;
  mutable_fields text[] := ARRAY[
    'state', 'attempt_count', 'next_retry_at', 'last_attempt_at', 'last_failure_code',
    'hive_transaction_id', 'operation_id', 'included_at', 'irreversible_at', 'reverted_at',
    'updated_at', 'row_version'
  ];
BEGIN
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'outbox attempt count cannot decrease';
  END IF;

  IF OLD.state <> NEW.state AND NOT (
    (OLD.state = 'queued' AND NEW.state IN (
      'broadcast', 'retryable_failed', 'included', 'irreversible', 'reverted', 'terminal_failed'
    ))
    OR (OLD.state = 'broadcast' AND NEW.state IN (
      'retryable_failed', 'included', 'irreversible', 'reverted', 'terminal_failed'
    ))
    OR (OLD.state = 'retryable_failed' AND NEW.state IN (
      'broadcast', 'included', 'irreversible', 'reverted', 'terminal_failed'
    ))
    OR (OLD.state = 'included' AND NEW.state IN ('irreversible', 'reverted'))
    OR (OLD.state = 'reverted' AND NEW.state IN (
      'queued', 'broadcast', 'retryable_failed', 'included', 'terminal_failed'
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox lifecycle transition';
  END IF;

  IF OLD.attempt_count > 0
     OR OLD.state <> 'queued'
     OR NEW.attempt_count > 0
     OR NEW.state <> 'queued' THEN
    old_stable := to_jsonb(OLD) - mutable_fields;
    new_stable := to_jsonb(NEW) - mutable_fields;
    IF old_stable IS DISTINCT FROM new_stable THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'broadcast outbox identity and canonical payload are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_outbox_payload_freeze
  BEFORE UPDATE ON game.match_publication_outbox
  FOR EACH ROW EXECUTE FUNCTION game.hc_freeze_match_outbox_payload();

-- publication item validation
CREATE OR REPLACE FUNCTION game.hc_validate_publication_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row game.match_publication_request%ROWTYPE;
  revision_row game.round_result_revision%ROWTYPE;
  outbox_type hive_projection.match_event_type;
  old_outbox_state game.match_publication_outbox_state;
  old_attempt_count integer;
  new_outbox_state game.match_publication_outbox_state;
  new_attempt_count integer;
  expected_event_type hive_projection.match_event_type;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT state, attempt_count INTO old_outbox_state, old_attempt_count
      FROM game.match_publication_outbox
     WHERE id = OLD.outbox_id;

    IF old_attempt_count > 0 OR old_outbox_state <> 'queued' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'attempted outbox membership is immutable';
    END IF;

    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT * INTO request_row
    FROM game.match_publication_request
   WHERE id = NEW.publication_request_id;
  SELECT * INTO revision_row
    FROM game.round_result_revision
   WHERE id = NEW.result_revision_id;
  SELECT event_type, state, attempt_count
    INTO outbox_type, new_outbox_state, new_attempt_count
    FROM game.match_publication_outbox
   WHERE id = NEW.outbox_id;

  IF new_attempt_count > 0 OR new_outbox_state <> 'queued' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'attempted outbox membership is immutable';
  END IF;

  expected_event_type := CASE request_row.request_type
    WHEN 'initial' THEN 'match_results_batch'::hive_projection.match_event_type
    WHEN 'correction' THEN 'match_result_corrected'::hive_projection.match_event_type
    WHEN 'invalidation' THEN 'match_result_invalidated'::hive_projection.match_event_type
  END;

  IF request_row.id IS NULL
     OR revision_row.id IS NULL
     OR request_row.round_id <> NEW.round_id
     OR request_row.result_revision_id <> NEW.result_revision_id
     OR revision_row.round_id <> NEW.round_id
     OR outbox_type IS DISTINCT FROM expected_event_type THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication item identities or event type do not agree';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_publication_item_validate
  BEFORE INSERT OR UPDATE OR DELETE ON game.match_publication_item
  FOR EACH ROW EXECUTE FUNCTION game.hc_validate_publication_item();

-- publication item set completeness
CREATE OR REPLACE FUNCTION game.hc_check_publication_item_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_source jsonb;
  new_source jsonb;
  old_outbox_id uuid;
  new_outbox_id uuid;
  affected_outbox_id uuid;
  expected_count integer;
  actual_count integer;
  minimum_position integer;
  maximum_position integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_source := to_jsonb(OLD);
    old_outbox_id := CASE
      WHEN TG_TABLE_NAME = 'match_publication_outbox' THEN (old_source ->> 'id')::uuid
      ELSE (old_source ->> 'outbox_id')::uuid
    END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_source := to_jsonb(NEW);
    new_outbox_id := CASE
      WHEN TG_TABLE_NAME = 'match_publication_outbox' THEN (new_source ->> 'id')::uuid
      ELSE (new_source ->> 'outbox_id')::uuid
    END;
  END IF;

  FOREACH affected_outbox_id IN ARRAY ARRAY[old_outbox_id, new_outbox_id]
  LOOP
    CONTINUE WHEN affected_outbox_id IS NULL;

    SELECT result_count INTO expected_count
      FROM game.match_publication_outbox
     WHERE id = affected_outbox_id;

    CONTINUE WHEN NOT FOUND;

    SELECT count(*), min(result_position), max(result_position)
      INTO actual_count, minimum_position, maximum_position
      FROM game.match_publication_item
     WHERE outbox_id = affected_outbox_id;

    IF actual_count <> expected_count
       OR minimum_position <> 0
       OR maximum_position <> expected_count - 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication item positions must be contiguous and match result_count';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_match_outbox_item_set
  AFTER INSERT OR UPDATE ON game.match_publication_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_publication_item_set();

CREATE CONSTRAINT TRIGGER trg_match_publication_item_set
  AFTER INSERT OR UPDATE OR DELETE ON game.match_publication_item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_publication_item_set();

-- match event validation
CREATE OR REPLACE FUNCTION hive_projection.hc_validate_match_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_row hive_projection.operation%ROWTYPE;
  old_operation_row hive_projection.operation%ROWTYPE;
  event_payload jsonb;
  event_data jsonb;
  is_replay boolean := false;
BEGIN
  SELECT * INTO operation_row
    FROM hive_projection.operation
   WHERE id = NEW.operation_id;

  IF NOT FOUND
     OR operation_row.operation_type NOT IN ('custom_json', 'custom_json_operation')
     OR operation_row.required_authority IS DISTINCT FROM 'posting'
     OR operation_row.application_id IS DISTINCT FROM 'hive.chameleon'
     OR operation_row.primary_account <> NEW.publisher_hive_account
     OR operation_row.validation_state <> 'accepted'
     OR operation_row.block_timestamp <> NEW.included_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'match event requires an accepted posting-authority hive.chameleon operation from the same publisher';
  END IF;

  BEGIN
    event_payload := (operation_row.payload ->> 'json')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'accepted match operation must contain a JSON event string';
  END;
  event_data := event_payload -> 'data';

  IF operation_row.payload -> 'required_auths' IS DISTINCT FROM '[]'::jsonb
     OR operation_row.payload -> 'required_posting_auths'
          IS DISTINCT FROM jsonb_build_array(NEW.publisher_hive_account)
     OR operation_row.payload ->> 'id' IS DISTINCT FROM 'hive.chameleon'
     OR event_payload ->> 'v' IS DISTINCT FROM NEW.schema_version::text
     OR event_payload ->> 'event_id' IS DISTINCT FROM NEW.event_uuid::text
     OR event_payload ->> 'type' IS DISTINCT FROM NEW.event_type::text
     OR event_data ->> 'publisher' IS DISTINCT FROM NEW.publisher_hive_account
     OR (
       NEW.event_type = 'match_results_batch'
       AND (
         event_data ->> 'batch_id' IS DISTINCT FROM NEW.batch_uuid::text
         OR (event_data ->> 'period_start')::timestamptz IS DISTINCT FROM NEW.publication_period_start
         OR (event_data ->> 'period_end')::timestamptz IS DISTINCT FROM NEW.publication_period_end
         OR event_data ->> 'result_count' IS DISTINCT FROM NEW.result_count::text
         OR CASE
           WHEN jsonb_typeof(event_data -> 'results') = 'array'
             THEN jsonb_array_length(event_data -> 'results') <> NEW.result_count
           ELSE true
         END
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'match event columns must agree with the accepted custom_json payload';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    is_replay := OLD.operation_state = 'reverted'
      AND NEW.operation_state = 'included'
      AND NEW.validation_state = 'accepted'
      AND NEW.operation_id <> OLD.operation_id;

    IF is_replay THEN
      SELECT * INTO old_operation_row
        FROM hive_projection.operation
       WHERE id = OLD.operation_id;

      IF NOT FOUND
         OR old_operation_row.state <> 'reverted'
         OR operation_row.state <> 'included'
         OR operation_row.payload ->> 'json' IS DISTINCT FROM old_operation_row.payload ->> 'json' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'fork replay requires the identical logical event on a new accepted included operation';
      END IF;
    END IF;

    IF NEW.event_uuid <> OLD.event_uuid
       OR NEW.batch_uuid IS DISTINCT FROM OLD.batch_uuid
       OR NEW.event_type <> OLD.event_type
       OR NEW.schema_version <> OLD.schema_version
       OR NEW.event_contract_version <> OLD.event_contract_version
       OR NEW.publication_period_start IS DISTINCT FROM OLD.publication_period_start
       OR NEW.publication_period_end IS DISTINCT FROM OLD.publication_period_end
       OR NEW.publisher_hive_account <> OLD.publisher_hive_account
       OR NEW.result_count <> OLD.result_count
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'accepted match event identity and content are immutable';
    END IF;

    IF (
      NEW.operation_id <> OLD.operation_id
      OR NEW.included_at <> OLD.included_at
    ) AND NOT is_replay THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'match event operation binding changes only during fork replay';
    END IF;

    IF OLD.operation_state <> NEW.operation_state
       AND NOT (
         (OLD.operation_state = 'included' AND NEW.operation_state IN ('irreversible', 'reverted'))
         OR is_replay
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid match event finality transition';
    END IF;
    IF OLD.operation_state = NEW.operation_state AND (
      NEW.irreversible_at IS DISTINCT FROM OLD.irreversible_at
      OR NEW.reverted_at IS DISTINCT FROM OLD.reverted_at
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'match event finality evidence is immutable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_event_validate
  BEFORE INSERT OR UPDATE ON hive_projection.match_event
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_validate_match_event();

-- operation/match_event state agreement
CREATE OR REPLACE FUNCTION hive_projection.hc_check_operation_match_event_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row jsonb := to_jsonb(NEW);
  affected_operation_id uuid;
  operation_row hive_projection.operation%ROWTYPE;
  event_row hive_projection.match_event%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'operation' THEN
    affected_operation_id := (source_row ->> 'id')::uuid;
  ELSE
    affected_operation_id := (source_row ->> 'operation_id')::uuid;
  END IF;

  SELECT * INTO operation_row
    FROM hive_projection.operation
   WHERE id = affected_operation_id;
  SELECT * INTO event_row
    FROM hive_projection.match_event
   WHERE operation_id = affected_operation_id;

  IF operation_row.id IS NOT NULL
     AND event_row.event_uuid IS NOT NULL
     AND (
       operation_row.state <> event_row.operation_state
       OR operation_row.validation_state <> 'accepted'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'accepted match event and raw operation states must agree at commit';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_operation_match_event_state_from_operation
  AFTER INSERT OR UPDATE ON hive_projection.operation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_operation_match_event_state();

CREATE CONSTRAINT TRIGGER trg_operation_match_event_state_from_event
  AFTER INSERT OR UPDATE ON hive_projection.match_event
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_operation_match_event_state();

-- match result expected head
CREATE OR REPLACE FUNCTION hive_projection.hc_match_result_expected_head(
  target_projected_result_id uuid,
  initial_event_id uuid
)
RETURNS TABLE (
  head_event_uuid uuid,
  head_state hive_projection.match_result_current_state,
  chain_is_connected boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
  next_event_uuid uuid;
  next_change_type hive_projection.match_change_type;
  active_change_count integer;
  traversed_change_count integer := 0;
BEGIN
  head_event_uuid := initial_event_id;
  head_state := 'current';

  SELECT count(*) INTO active_change_count
    FROM hive_projection.match_result_change change
    JOIN hive_projection.match_event event ON event.event_uuid = change.event_uuid
   WHERE change.projected_result_id = target_projected_result_id
     AND event.operation_state <> 'reverted';

  WHILE traversed_change_count < active_change_count
  LOOP
    SELECT change.event_uuid, change.change_type
      INTO next_event_uuid, next_change_type
      FROM hive_projection.match_result_change change
      JOIN hive_projection.match_event event ON event.event_uuid = change.event_uuid
     WHERE change.projected_result_id = target_projected_result_id
       AND change.supersedes_event_uuid = head_event_uuid
       AND event.operation_state <> 'reverted';

    EXIT WHEN NOT FOUND;

    head_event_uuid := next_event_uuid;
    head_state := CASE next_change_type
      WHEN 'correction' THEN 'corrected'::hive_projection.match_result_current_state
      WHEN 'invalidation' THEN 'invalidated'::hive_projection.match_result_current_state
    END;
    traversed_change_count := traversed_change_count + 1;
  END LOOP;

  chain_is_connected := traversed_change_count = active_change_count;
  RETURN NEXT;
END;
$$;

-- assert stored match result head
CREATE OR REPLACE FUNCTION hive_projection.hc_assert_stored_match_result_head(
  target_projected_result_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  result_row hive_projection.match_result%ROWTYPE;
  initial_event hive_projection.match_event%ROWTYPE;
  expected_event_uuid uuid;
  expected_state hive_projection.match_result_current_state;
  chain_is_connected boolean;
BEGIN
  SELECT * INTO result_row
    FROM hive_projection.match_result
   WHERE id = target_projected_result_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO initial_event
    FROM hive_projection.match_event
   WHERE event_uuid = result_row.initial_event_uuid;

  SELECT expected.head_event_uuid, expected.head_state, expected.chain_is_connected
    INTO expected_event_uuid, expected_state, chain_is_connected
    FROM hive_projection.hc_match_result_expected_head(
      result_row.id,
      result_row.initial_event_uuid
    ) expected;

  IF initial_event.event_uuid IS NULL
     OR initial_event.event_type <> 'match_results_batch'
     OR initial_event.operation_state = 'reverted'
     OR initial_event.validation_state <> 'accepted'
     OR NOT chain_is_connected
     OR result_row.current_event_uuid <> expected_event_uuid
     OR result_row.current_state <> expected_state THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'projected result current pointer must equal its connected accepted change-chain head';
  END IF;
END;
$$;

-- match result validation
CREATE OR REPLACE FUNCTION hive_projection.hc_validate_match_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  initial_event hive_projection.match_event%ROWTYPE;
  initial_result jsonb;
  expected_event_uuid uuid;
  expected_state hive_projection.match_result_current_state;
  chain_is_connected boolean;
BEGIN
  SELECT * INTO initial_event
    FROM hive_projection.match_event
   WHERE event_uuid = NEW.initial_event_uuid;

  IF NOT FOUND
     OR initial_event.event_type <> 'match_results_batch'
     OR initial_event.operation_state = 'reverted'
     OR initial_event.validation_state <> 'accepted' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'projected match result requires an accepted initial batch event';
  END IF;

  SELECT ((operation.payload ->> 'json')::jsonb -> 'data' -> 'results') -> NEW.result_position
    INTO initial_result
    FROM hive_projection.operation operation
   WHERE operation.id = initial_event.operation_id;

  IF initial_result IS NULL
     OR initial_result ->> 'round_id' IS DISTINCT FROM NEW.round_id::text
     OR initial_result ->> 'result_schema' IS DISTINCT FROM NEW.result_schema_version
     OR initial_result ->> 'scoring_rules' IS DISTINCT FROM NEW.scoring_rule_version
     OR initial_result #>> '{map,version_id}' IS DISTINCT FROM NEW.map_version_id::text
     OR initial_result #>> '{map,content_sha256}' IS DISTINCT FROM NEW.map_content_sha256::text
     OR initial_result #>> '{server,build}' IS DISTINCT FROM NEW.server_build_version
     OR initial_result #>> '{server,protocol}' IS DISTINCT FROM NEW.match_protocol_version
     OR initial_result ->> 'result_sha256' IS DISTINCT FROM NEW.public_result_sha256::text THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'projected initial result must match its accepted batch item';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.current_event_uuid <> NEW.initial_event_uuid OR NEW.current_state <> 'current' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new projected result must start at its initial event';
    END IF;
  ELSIF NEW.id <> OLD.id
     OR NEW.initial_event_uuid <> OLD.initial_event_uuid
     OR NEW.result_position <> OLD.result_position
     OR NEW.round_id <> OLD.round_id
     OR NEW.result_schema_version <> OLD.result_schema_version
     OR NEW.scoring_rule_version <> OLD.scoring_rule_version
     OR NEW.map_version_id <> OLD.map_version_id
     OR NEW.map_content_sha256 <> OLD.map_content_sha256
     OR NEW.server_build_version <> OLD.server_build_version
     OR NEW.match_protocol_version <> OLD.match_protocol_version
     OR NEW.public_result_sha256 <> OLD.public_result_sha256
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'projected initial match result evidence is immutable';
  END IF;

  SELECT head.head_event_uuid, head.head_state, head.chain_is_connected
    INTO expected_event_uuid, expected_state, chain_is_connected
    FROM hive_projection.hc_match_result_expected_head(NEW.id, NEW.initial_event_uuid) head;

  IF NOT chain_is_connected
     OR NEW.current_event_uuid <> expected_event_uuid
     OR NEW.current_state <> expected_state THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'projected result current pointer must equal its connected accepted change-chain head';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_result_validate
  BEFORE INSERT OR UPDATE ON hive_projection.match_result
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_validate_match_result();

-- match result change validation
CREATE OR REPLACE FUNCTION hive_projection.hc_validate_match_result_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projected_result hive_projection.match_result%ROWTYPE;
  original_event hive_projection.match_event%ROWTYPE;
  superseded_event hive_projection.match_event%ROWTYPE;
  change_event hive_projection.match_event%ROWTYPE;
  replacement_revision game.round_result_revision%ROWTYPE;
  event_data jsonb;
  replacement_result jsonb;
  expected_event_type hive_projection.match_event_type;
BEGIN
  SELECT * INTO projected_result
    FROM hive_projection.match_result
   WHERE id = NEW.projected_result_id;
  SELECT * INTO original_event
    FROM hive_projection.match_event
   WHERE event_uuid = NEW.original_event_uuid;
  SELECT * INTO superseded_event
    FROM hive_projection.match_event
   WHERE event_uuid = NEW.supersedes_event_uuid;
  SELECT event.* INTO change_event
    FROM hive_projection.match_event event
   WHERE event.event_uuid = NEW.event_uuid;
  SELECT (operation.payload ->> 'json')::jsonb -> 'data' INTO event_data
    FROM hive_projection.match_event event
    JOIN hive_projection.operation operation ON operation.id = event.operation_id
   WHERE event.event_uuid = NEW.event_uuid;

  expected_event_type := CASE NEW.change_type
    WHEN 'correction' THEN 'match_result_corrected'::hive_projection.match_event_type
    WHEN 'invalidation' THEN 'match_result_invalidated'::hive_projection.match_event_type
  END;

  IF projected_result.id IS NULL
     OR original_event.event_uuid IS NULL
     OR superseded_event.event_uuid IS NULL
     OR change_event.event_uuid IS NULL
     OR projected_result.round_id <> NEW.round_id
     OR projected_result.initial_event_uuid <> NEW.original_event_uuid
     OR projected_result.current_event_uuid <> NEW.supersedes_event_uuid
     OR original_event.event_type <> 'match_results_batch'
     OR original_event.batch_uuid <> NEW.original_batch_uuid
     OR original_event.operation_state = 'reverted'
     OR superseded_event.operation_state = 'reverted'
     OR change_event.event_type <> expected_event_type
     OR change_event.operation_state = 'reverted'
     OR change_event.validation_state <> 'accepted'
     OR NEW.event_uuid = NEW.supersedes_event_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'match result change must extend the accepted current event chain';
  END IF;

  IF NEW.supersedes_event_uuid <> NEW.original_event_uuid
     AND NOT EXISTS (
       SELECT 1
         FROM hive_projection.match_result_change previous_change
        WHERE previous_change.projected_result_id = NEW.projected_result_id
          AND previous_change.event_uuid = NEW.supersedes_event_uuid
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'match result change cannot skip or cross a result chain';
  END IF;

  IF event_data ->> 'round_id' IS DISTINCT FROM NEW.round_id::text
     OR event_data ->> 'original_batch_id' IS DISTINCT FROM NEW.original_batch_uuid::text
     OR event_data ->> 'original_event_id' IS DISTINCT FROM NEW.original_event_uuid::text
     OR event_data ->> 'supersedes_event_id' IS DISTINCT FROM NEW.supersedes_event_uuid::text
     OR event_data ->> 'reason_code' IS DISTINCT FROM NEW.reason_code THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'match result change lineage must agree with its accepted payload';
  END IF;

  IF NEW.change_type = 'correction' THEN
    SELECT * INTO replacement_revision
      FROM game.round_result_revision
     WHERE id = NEW.replacement_result_revision_id;
    replacement_result := event_data -> 'replacement_result';

    IF NOT FOUND
       OR replacement_revision.round_id <> NEW.round_id
       OR replacement_revision.revision_type <> 'correction'
       OR replacement_revision.result_schema_version IS DISTINCT FROM NEW.replacement_result_schema_version
       OR replacement_revision.scoring_rule_version IS DISTINCT FROM NEW.replacement_scoring_rule_version
       OR replacement_revision.canonical_complete_result_sha256 IS DISTINCT FROM NEW.replacement_public_result_sha256
       OR replacement_revision.reason_code IS DISTINCT FROM NEW.reason_code
       OR replacement_result ->> 'round_id' IS DISTINCT FROM NEW.round_id::text
       OR replacement_result ->> 'result_schema' IS DISTINCT FROM NEW.replacement_result_schema_version
       OR replacement_result ->> 'scoring_rules' IS DISTINCT FROM NEW.replacement_scoring_rule_version
       OR replacement_result #>> '{map,version_id}' IS DISTINCT FROM NEW.replacement_map_version_id::text
       OR replacement_result #>> '{map,content_sha256}' IS DISTINCT FROM NEW.replacement_map_content_sha256::text
       OR replacement_result #>> '{server,build}' IS DISTINCT FROM NEW.replacement_server_build_version
       OR replacement_result #>> '{server,protocol}' IS DISTINCT FROM NEW.replacement_match_protocol_version
       OR replacement_result ->> 'result_sha256' IS DISTINCT FROM NEW.replacement_public_result_sha256::text THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'correction projection must match its local revision and public replacement';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_result_change_validate
  BEFORE INSERT ON hive_projection.match_result_change
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_validate_match_result_change();

-- match result change head check
CREATE OR REPLACE FUNCTION hive_projection.hc_check_match_result_change_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_state hive_projection.match_result_current_state := CASE NEW.change_type
    WHEN 'correction' THEN 'corrected'::hive_projection.match_result_current_state
    WHEN 'invalidation' THEN 'invalidated'::hive_projection.match_result_current_state
  END;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM hive_projection.match_result result
     WHERE result.id = NEW.projected_result_id
       AND result.current_event_uuid = NEW.event_uuid
       AND result.current_state = expected_state
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'projected result pointer must advance with its appended change';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_match_result_change_head
  AFTER INSERT ON hive_projection.match_result_change
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_match_result_change_head();

-- match event result heads check
CREATE OR REPLACE FUNCTION hive_projection.hc_check_match_event_result_heads()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projected_result_id uuid;
BEGIN
  FOR projected_result_id IN
    SELECT result.id
      FROM hive_projection.match_result result
     WHERE result.initial_event_uuid = NEW.event_uuid
        OR result.current_event_uuid = NEW.event_uuid
    UNION
    SELECT change.projected_result_id
      FROM hive_projection.match_result_change change
     WHERE change.event_uuid = NEW.event_uuid
        OR change.original_event_uuid = NEW.event_uuid
        OR change.supersedes_event_uuid = NEW.event_uuid
  LOOP
    PERFORM hive_projection.hc_assert_stored_match_result_head(projected_result_id);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_match_event_result_heads
  AFTER UPDATE ON hive_projection.match_event
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_match_event_result_heads();

-- Re-create the hc_match_publisher role and its scoped grants (dropped by the
-- removal migration). Matches the shape from 20260716000400_database_roles.sql
-- and 20260723000200_publication_pipeline_roles.sql.

CREATE ROLE hc_match_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE hc_match_publisher RESET ALL;
ALTER ROLE hc_match_publisher IN DATABASE hive_chameleon RESET ALL;

GRANT USAGE ON SCHEMA game, hive_projection TO hc_match_publisher;
GRANT USAGE ON SCHEMA identity, content, tournament TO hc_match_publisher;

GRANT SELECT ON
  game.game_round,
  game.round_result_revision,
  game.match_publication_request,
  game.match_publication_outbox,
  game.match_publication_item,
  hive_projection.operation,
  hive_projection.match_event,
  hive_projection.match_result,
  hive_projection.match_result_change
  TO hc_match_publisher;
GRANT INSERT ON
  game.match_publication_outbox,
  game.match_publication_item
  TO hc_match_publisher;
GRANT UPDATE (
  state,
  attempt_count,
  next_retry_at,
  last_attempt_at,
  last_failure_code,
  published_at
) ON game.match_publication_request TO hc_match_publisher;
GRANT UPDATE (
  state,
  attempt_count,
  next_retry_at,
  last_attempt_at,
  last_failure_code,
  hive_transaction_id,
  operation_id,
  included_at,
  irreversible_at,
  reverted_at
) ON game.match_publication_outbox TO hc_match_publisher;

GRANT SELECT ON
  identity.player,
  content.map,
  content.map_version,
  content.map_asset,
  game.round_participant,
  game.round_discovery,
  game.round_like,
  tournament.match_game_round,
  tournament.tournament_match
  TO hc_match_publisher;
GRANT UPDATE (updated_at)
  ON game.match_publication_request, game.match_publication_outbox
  TO hc_match_publisher;

GRANT SELECT, INSERT ON hive_projection.transaction_intent TO hc_match_publisher;
GRANT UPDATE (state, hive_transaction_id, failure_code)
  ON hive_projection.transaction_intent
  TO hc_match_publisher;
GRANT UPDATE (updated_at)
  ON hive_projection.transaction_intent
  TO hc_match_publisher;

GRANT EXECUTE ON FUNCTION public.hc_is_uuid_v7(uuid), public.hc_is_sha256(text)
  TO hc_match_publisher;
GRANT EXECUTE ON FUNCTION public.digest(bytea, text) TO hc_match_publisher;

CREATE POLICY transaction_intent_match_publisher
  ON hive_projection.transaction_intent
  FOR ALL TO hc_match_publisher
  USING (
    authorization_mode = 'official_service'
    AND official_service_role = 'match_publisher'
  )
  WITH CHECK (
    authorization_mode = 'official_service'
    AND official_service_role = 'match_publisher'
  );

-- Re-grant the projector and product-API privileges on the match projection
-- tables. The removal migration dropped these tables with CASCADE, which also
-- dropped every grant the baseline role migration (20260716000400) had made on
-- them; recreating the tables above does not restore those grants. Without this
-- the HAF projector (hc_projector) cannot materialize match events and the API
-- (hc_api) cannot read them. match_result_change is append-only, so the
-- projector receives INSERT but never UPDATE (mirroring the baseline REVOKE).
GRANT SELECT, INSERT, UPDATE ON
  hive_projection.match_event,
  hive_projection.match_result
  TO hc_projector;
GRANT SELECT, INSERT ON hive_projection.match_result_change TO hc_projector;
GRANT SELECT ON
  hive_projection.match_event,
  hive_projection.match_result,
  hive_projection.match_result_change
  TO hc_api;
GRANT EXECUTE ON FUNCTION
  hive_projection.hc_match_result_expected_head(uuid, uuid),
  hive_projection.hc_assert_stored_match_result_head(uuid)
  TO hc_projector;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
