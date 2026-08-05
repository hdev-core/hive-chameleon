-- migrate:up

-- Exact canonical result bytes now live with the immutable PostgreSQL revision. Existing
-- non-invalidated revisions cannot be converted safely because the repository previously stored
-- only a hash and an unused external key.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM game.round_result_revision
     WHERE revision_type <> 'invalidation'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'canonical result migration requires an empty pre-release result history';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_game_round_terminal_bundle ON game.game_round;
DROP FUNCTION IF EXISTS game.hc_check_terminal_round_bundle();

DROP FUNCTION IF EXISTS game.hc_validate_publication_request() CASCADE;
DROP FUNCTION IF EXISTS game.hc_check_publication_request_round_state() CASCADE;
DROP FUNCTION IF EXISTS game.hc_freeze_match_outbox_payload() CASCADE;
DROP FUNCTION IF EXISTS game.hc_validate_publication_item() CASCADE;
DROP FUNCTION IF EXISTS game.hc_check_publication_item_set() CASCADE;

DROP FUNCTION IF EXISTS hive_projection.hc_validate_match_event() CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_check_operation_match_event_state() CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_match_result_expected_head(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_assert_stored_match_result_head(uuid) CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_validate_match_result() CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_validate_match_result_change() CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_check_match_result_change_head() CASCADE;
DROP FUNCTION IF EXISTS hive_projection.hc_check_match_event_result_heads() CASCADE;

DROP POLICY IF EXISTS transaction_intent_match_publisher
  ON hive_projection.transaction_intent;

DROP TABLE IF EXISTS hive_projection.match_result_change CASCADE;
DROP TABLE IF EXISTS hive_projection.match_result CASCADE;
DROP TABLE IF EXISTS hive_projection.match_event CASCADE;
DROP TABLE IF EXISTS game.match_publication_item CASCADE;
DROP TABLE IF EXISTS game.match_publication_outbox CASCADE;
DROP TABLE IF EXISTS game.match_publication_request CASCADE;

DROP TYPE IF EXISTS hive_projection.match_change_type;
DROP TYPE IF EXISTS hive_projection.match_result_current_state;
DROP TYPE IF EXISTS hive_projection.match_event_type;
DROP TYPE IF EXISTS game.match_publication_outbox_state;
DROP TYPE IF EXISTS game.match_publication_request_state;
DROP TYPE IF EXISTS game.match_publication_request_type;

ALTER TABLE game.round_result_revision
  DROP CONSTRAINT chk_round_result_revision_initial,
  DROP CONSTRAINT chk_round_result_revision_correction,
  DROP CONSTRAINT chk_round_result_revision_invalidation,
  DROP COLUMN canonical_result_object_key,
  ADD COLUMN canonical_complete_result bytea;

ALTER TABLE game.round_result_revision
  ADD CONSTRAINT chk_round_result_revision_initial
    CHECK (
      revision_type <> 'initial'
      OR (
        revision_number = 1
        AND previous_revision_id IS NULL
        AND reason_code IS NULL
        AND canonical_complete_result_sha256 IS NOT NULL
        AND canonical_complete_result IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_round_result_revision_correction
    CHECK (
      revision_type <> 'correction'
      OR (
        previous_revision_id IS NOT NULL
        AND reason_code IS NOT NULL
        AND canonical_complete_result_sha256 IS NOT NULL
        AND canonical_complete_result IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_round_result_revision_invalidation
    CHECK (
      revision_type <> 'invalidation'
      OR (
        previous_revision_id IS NOT NULL
        AND reason_code IS NOT NULL
        AND canonical_complete_result_sha256 IS NULL
        AND canonical_complete_result IS NULL
      )
    ),
  ADD CONSTRAINT chk_round_result_revision_canonical_size
    CHECK (
      canonical_complete_result IS NULL
      OR octet_length(canonical_complete_result) BETWEEN 1 AND 1048576
    ),
  ADD CONSTRAINT chk_round_result_revision_canonical_sha256
    CHECK (
      canonical_complete_result IS NULL
      OR encode(digest(canonical_complete_result, 'sha256'), 'hex') =
         canonical_complete_result_sha256
    );

COMMENT ON COLUMN game.round_result_revision.canonical_complete_result IS
  'Exact immutable UTF-8 canonical JSON bytes whose SHA-256 is stored on this revision.';

CREATE OR REPLACE FUNCTION game.hc_check_terminal_round_bundle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  participant_count integer;
  initial_hunter_count integer;
  initial_revision_count integer;
BEGIN
  IF NEW.status = 'completed' THEN
    SELECT count(*), count(*) FILTER (WHERE initial_role = 'hunter')
      INTO participant_count, initial_hunter_count
      FROM game.round_participant
     WHERE round_id = NEW.id;

    SELECT count(*) INTO initial_revision_count
      FROM game.round_result_revision
     WHERE round_id = NEW.id AND revision_type = 'initial';

    IF participant_count < 2
       OR initial_hunter_count <> NEW.hunter_count
       OR participant_count <= NEW.hunter_count
       OR initial_revision_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'completed round has an incomplete terminal bundle';
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
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'round participant did not belong to the lobby lifecycle';
    END IF;
  ELSIF NEW.status = 'aborted' THEN
    IF EXISTS (SELECT 1 FROM game.round_participant WHERE round_id = NEW.id)
       OR EXISTS (SELECT 1 FROM game.round_result_revision WHERE round_id = NEW.id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'aborted round must not contain terminal result rows';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_game_round_terminal_bundle
  AFTER INSERT OR UPDATE ON game.game_round
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_terminal_round_bundle();

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA
  identity, social, game, content, commerce, tournament, hive_projection
  FROM hc_match_publisher;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA
  public, identity, game, content, hive_projection
  FROM hc_match_publisher;
REVOKE ALL PRIVILEGES ON SCHEMA
  identity, social, game, content, commerce, tournament, hive_projection
  FROM hc_match_publisher;
DROP OWNED BY hc_match_publisher;
DROP ROLE hc_match_publisher;

DROP TABLE IF EXISTS identity.public_record_disclosure_acknowledgment CASCADE;
DROP TABLE IF EXISTS identity.public_record_disclosure CASCADE;
DROP TYPE IF EXISTS identity.disclosure_ack_source;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
