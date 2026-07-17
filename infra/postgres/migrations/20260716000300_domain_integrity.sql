-- migrate:up

CREATE OR REPLACE FUNCTION public.hc_reject_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I.%I is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER trg_round_result_revision_append_only
  BEFORE UPDATE OR DELETE ON game.round_result_revision
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

CREATE TRIGGER trg_map_lifecycle_event_append_only
  BEFORE UPDATE OR DELETE ON content.map_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

CREATE TRIGGER trg_map_review_append_only
  BEFORE UPDATE OR DELETE ON content.map_review
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

CREATE TRIGGER trg_authorization_audit_append_only
  BEFORE UPDATE OR DELETE ON identity.authorization_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

CREATE TRIGGER trg_match_result_change_append_only
  BEFORE UPDATE OR DELETE ON hive_projection.match_result_change
  FOR EACH ROW EXECUTE FUNCTION public.hc_reject_row_mutation();

CREATE OR REPLACE FUNCTION game.hc_protect_terminal_round()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'aborted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'terminal game rounds are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_game_round_terminal_immutable
  BEFORE UPDATE OR DELETE ON game.game_round
  FOR EACH ROW EXECUTE FUNCTION game.hc_protect_terminal_round();

CREATE OR REPLACE FUNCTION game.hc_protect_round_detail()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_source jsonb;
  new_source jsonb;
  old_round_id uuid;
  new_round_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_source := to_jsonb(OLD);
    IF TG_TABLE_NAME = 'round_disguise_snapshot' THEN
      SELECT participant.round_id
        INTO old_round_id
        FROM game.round_participant participant
       WHERE participant.id = (old_source ->> 'round_participant_id')::uuid;
    ELSE
      old_round_id := (old_source ->> 'round_id')::uuid;
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_source := to_jsonb(NEW);
    IF TG_TABLE_NAME = 'round_disguise_snapshot' THEN
      SELECT participant.round_id
        INTO new_round_id
        FROM game.round_participant participant
       WHERE participant.id = (new_source ->> 'round_participant_id')::uuid;
    ELSE
      new_round_id := (new_source ->> 'round_id')::uuid;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM game.game_round round
     WHERE round.id IN (old_round_id, new_round_id)
       AND round.status IN ('completed', 'aborted')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'terminal round detail is immutable';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_round_participant_terminal_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON game.round_participant
  FOR EACH ROW EXECUTE FUNCTION game.hc_protect_round_detail();

CREATE TRIGGER trg_round_discovery_terminal_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON game.round_discovery
  FOR EACH ROW EXECUTE FUNCTION game.hc_protect_round_detail();

CREATE TRIGGER trg_round_disguise_terminal_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON game.round_disguise_snapshot
  FOR EACH ROW EXECUTE FUNCTION game.hc_protect_round_detail();

CREATE TRIGGER trg_round_like_terminal_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON game.round_like
  FOR EACH ROW EXECUTE FUNCTION game.hc_protect_round_detail();

CREATE OR REPLACE FUNCTION game.hc_validate_result_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  round_row game.game_round%ROWTYPE;
  previous_row game.round_result_revision%ROWTYPE;
BEGIN
  SELECT * INTO round_row
    FROM game.game_round
   WHERE id = NEW.round_id
   FOR UPDATE;

  IF NOT FOUND OR round_row.status = 'aborted' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'revision requires a non-aborted round';
  END IF;

  IF NEW.revision_type = 'initial' THEN
    IF NEW.revision_number <> 1 OR NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'initial revision must be revision one';
    END IF;
    IF NEW.result_schema_version IS DISTINCT FROM round_row.result_schema_version
       OR NEW.scoring_rule_version IS DISTINCT FROM round_row.scoring_rule_version
       OR NEW.canonical_complete_result_sha256 IS DISTINCT FROM round_row.canonical_result_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'initial revision must match round versions and hash';
    END IF;
  ELSE
    SELECT * INTO previous_row
      FROM game.round_result_revision
     WHERE id = NEW.previous_revision_id
     FOR UPDATE;

    IF NOT FOUND
       OR previous_row.round_id <> NEW.round_id
       OR NEW.revision_number <> previous_row.revision_number + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'result revision chain must be same-round and sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_round_result_revision_validate
  BEFORE INSERT ON game.round_result_revision
  FOR EACH ROW EXECUTE FUNCTION game.hc_validate_result_revision();

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

CREATE CONSTRAINT TRIGGER trg_game_round_terminal_bundle
  AFTER INSERT OR UPDATE ON game.game_round
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_terminal_round_bundle();

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

CREATE OR REPLACE FUNCTION game.hc_check_lobby_host_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_source jsonb;
  new_source jsonb;
  old_lobby_id uuid;
  new_lobby_id uuid;
  affected_lobby_id uuid;
  lobby_row game.lobby%ROWTYPE;
  open_assignment_count integer;
  open_host_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_source := to_jsonb(OLD);
    old_lobby_id := CASE
      WHEN TG_TABLE_NAME = 'lobby' THEN (old_source ->> 'id')::uuid
      ELSE (old_source ->> 'lobby_id')::uuid
    END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_source := to_jsonb(NEW);
    new_lobby_id := CASE
      WHEN TG_TABLE_NAME = 'lobby' THEN (new_source ->> 'id')::uuid
      ELSE (new_source ->> 'lobby_id')::uuid
    END;
  END IF;

  FOREACH affected_lobby_id IN ARRAY ARRAY[old_lobby_id, new_lobby_id]
  LOOP
    CONTINUE WHEN affected_lobby_id IS NULL;

    SELECT * INTO lobby_row
      FROM game.lobby
     WHERE id = affected_lobby_id;
    CONTINUE WHEN NOT FOUND;

    SELECT count(*), min(host_player_id::text)::uuid
      INTO open_assignment_count, open_host_id
      FROM game.lobby_host_assignment
     WHERE lobby_id = affected_lobby_id
       AND ended_at IS NULL;

    IF lobby_row.closed_at IS NULL THEN
      IF open_assignment_count <> 1 OR open_host_id <> lobby_row.current_host_player_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'open lobby must have one matching current host assignment';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM game.lobby_membership
         WHERE lobby_id = affected_lobby_id
           AND player_id = open_host_id
           AND left_at IS NULL
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'current host must be an open lobby member';
      END IF;
    ELSIF open_assignment_count > 1
       OR (open_assignment_count = 1 AND open_host_id <> lobby_row.current_host_player_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'closed lobby host history is inconsistent';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_lobby_host_consistency_lobby
  AFTER INSERT OR UPDATE ON game.lobby
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_lobby_host_consistency();

CREATE CONSTRAINT TRIGGER trg_lobby_host_consistency_assignment
  AFTER INSERT OR UPDATE OR DELETE ON game.lobby_host_assignment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_lobby_host_consistency();

CREATE CONSTRAINT TRIGGER trg_lobby_host_consistency_membership
  AFTER INSERT OR UPDATE OR DELETE ON game.lobby_membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION game.hc_check_lobby_host_consistency();

CREATE OR REPLACE FUNCTION identity.hc_validate_role_scope(
  scope_type identity.role_scope_type,
  scope_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF scope_type = 'platform' THEN
    IF scope_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform scope cannot carry a resource id';
    END IF;
  ELSIF scope_type = 'map' THEN
    IF NOT EXISTS (SELECT 1 FROM content.map WHERE id = scope_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'role scope map does not exist';
    END IF;
  ELSIF scope_type = 'tournament' THEN
    IF NOT EXISTS (SELECT 1 FROM tournament.tournament WHERE id = scope_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'role scope tournament does not exist';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION identity.hc_validate_role_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM identity.hc_validate_role_scope(NEW.scope_type, NEW.scope_id);

  IF NEW.state = 'approved' AND NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'expired role approval cannot be approved';
  END IF;
  IF NEW.decided_at IS NOT NULL AND NEW.decided_at < NEW.requested_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role approval decision cannot predate its request';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'decided role approval is immutable';
    END IF;

    IF NEW.target_player_id <> OLD.target_player_id
       OR NEW.role <> OLD.role
       OR NEW.scope_type <> OLD.scope_type
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.valid_from <> OLD.valid_from
       OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
       OR NEW.requested_by_player_id <> OLD.requested_by_player_id
       OR NEW.reason <> OLD.reason
       OR NEW.requested_at <> OLD.requested_at
       OR NEW.expires_at <> OLD.expires_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'role approval request fields are immutable';
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_platform_role_approval_validate
  BEFORE INSERT OR UPDATE ON identity.platform_role_approval
  FOR EACH ROW EXECUTE FUNCTION identity.hc_validate_role_approval();

CREATE OR REPLACE FUNCTION identity.hc_validate_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval identity.platform_role_approval%ROWTYPE;
  grant_audit identity.authorization_audit_event%ROWTYPE;
  revoke_audit identity.authorization_audit_event%ROWTYPE;
BEGIN
  PERFORM identity.hc_validate_role_scope(NEW.scope_type, NEW.scope_id);

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO grant_audit
      FROM identity.authorization_audit_event
     WHERE id = NEW.grant_audit_event_id;

    IF NOT FOUND
       OR grant_audit.actor_type <> 'player'
       OR grant_audit.actor_player_id <> NEW.granted_by_player_id
       OR grant_audit.decision <> 'grant'
       OR grant_audit.subject_player_id <> NEW.player_id
       OR grant_audit.role <> NEW.role
       OR grant_audit.scope_type IS DISTINCT FROM NEW.scope_type
       OR grant_audit.scope_id IS DISTINCT FROM NEW.scope_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role grant requires matching append-only audit evidence';
    END IF;

    IF NEW.approval_id IS NOT NULL THEN
      SELECT * INTO approval
        FROM identity.platform_role_approval
       WHERE id = NEW.approval_id;

      IF NOT FOUND
         OR approval.state <> 'approved'
         OR approval.expires_at <= clock_timestamp()
         OR approval.target_player_id <> NEW.player_id
         OR approval.role <> NEW.role
         OR approval.scope_type <> NEW.scope_type
         OR approval.scope_id IS DISTINCT FROM NEW.scope_id
         OR approval.valid_from <> NEW.valid_from
         OR approval.valid_until IS DISTINCT FROM NEW.valid_until
         OR approval.requested_by_player_id <> NEW.granted_by_player_id
         OR approval.approved_by_player_id = NEW.granted_by_player_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role assignment approval does not match the grant';
      END IF;
    ELSIF NEW.role IN ('platform_administrator', 'security_auditor') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'high-risk role requires independent approval';
    END IF;
  ELSE
    IF NEW.player_id <> OLD.player_id
       OR NEW.role <> OLD.role
       OR NEW.scope_type <> OLD.scope_type
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.valid_from <> OLD.valid_from
       OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
       OR NEW.granted_by_player_id <> OLD.granted_by_player_id
       OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
       OR NEW.grant_audit_event_id <> OLD.grant_audit_event_id
       OR NEW.reason <> OLD.reason
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'role grant fields are immutable';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'role revocation is immutable';
    END IF;

    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      SELECT * INTO revoke_audit
        FROM identity.authorization_audit_event
       WHERE id = NEW.revocation_audit_event_id;

      IF NOT FOUND
         OR revoke_audit.actor_type <> 'player'
         OR revoke_audit.actor_player_id <> NEW.revoked_by_player_id
         OR revoke_audit.decision <> 'revoke'
         OR revoke_audit.subject_player_id <> NEW.player_id
         OR revoke_audit.role <> NEW.role
         OR revoke_audit.scope_type IS DISTINCT FROM NEW.scope_type
         OR revoke_audit.scope_id IS DISTINCT FROM NEW.scope_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role revocation requires matching append-only audit evidence';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_platform_role_assignment_validate
  BEFORE INSERT OR UPDATE ON identity.platform_role_assignment
  FOR EACH ROW EXECUTE FUNCTION identity.hc_validate_role_assignment();

CREATE OR REPLACE FUNCTION content.hc_protect_submitted_map_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'submitted map versions cannot be deleted';
    END IF;

    IF NEW.map_id <> OLD.map_id
       OR NEW.version_number <> OLD.version_number
       OR NEW.manifest <> OLD.manifest
       OR NEW.license_declaration_version <> OLD.license_declaration_version
       OR NEW.license_accepted_at <> OLD.license_accepted_at
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'submitted map identity and content are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_map_version_submitted_immutable
  BEFORE UPDATE OR DELETE ON content.map_version
  FOR EACH ROW EXECUTE FUNCTION content.hc_protect_submitted_map_version();

CREATE OR REPLACE FUNCTION content.hc_protect_submitted_map_asset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_version_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.map_version_id END;
  new_version_id uuid := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.map_version_id END;
BEGIN
  IF EXISTS (
    SELECT 1 FROM content.map_version
     WHERE id IN (old_version_id, new_version_id)
       AND submitted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'assets of a submitted map version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_map_asset_submitted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON content.map_asset
  FOR EACH ROW EXECUTE FUNCTION content.hc_protect_submitted_map_asset();

CREATE OR REPLACE FUNCTION content.hc_validate_map_review_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM content.map_version version
      JOIN content.map map ON map.id = version.map_id
     WHERE version.id = NEW.map_version_id
       AND map.creator_player_id = NEW.reviewer_player_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'map creator cannot review their own submission';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_map_review_no_self_review
  BEFORE INSERT ON content.map_review
  FOR EACH ROW EXECUTE FUNCTION content.hc_validate_map_review_actor();

CREATE OR REPLACE FUNCTION hive_projection.hc_validate_checkpoint_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'block checkpoints retain fork history';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.source <> OLD.source
     OR NEW.block_number <> OLD.block_number
     OR NEW.block_id <> OLD.block_id
     OR NEW.previous_block_id IS DISTINCT FROM OLD.previous_block_id
     OR NEW.block_timestamp <> OLD.block_timestamp
     OR NEW.observed_at <> OLD.observed_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'block checkpoint evidence is immutable';
  END IF;

  IF OLD.state = 'irreversible' AND NEW.state <> 'irreversible' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'irreversible block cannot be reverted';
  END IF;
  IF OLD.state = 'reverted' AND NEW.state <> 'reverted' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reverted checkpoint must remain historical';
  END IF;
  IF OLD.state <> NEW.state
     AND NOT (OLD.state = 'included' AND NEW.state IN ('irreversible', 'reverted')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid block checkpoint state transition';
  END IF;
  IF OLD.state = NEW.state AND (
    NEW.irreversible_at IS DISTINCT FROM OLD.irreversible_at
    OR NEW.reverted_at IS DISTINCT FROM OLD.reverted_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'block finality evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_block_checkpoint_mutation
  BEFORE UPDATE OR DELETE ON hive_projection.block_checkpoint
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_validate_checkpoint_mutation();

CREATE OR REPLACE FUNCTION hive_projection.hc_validate_operation_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checkpoint hive_projection.block_checkpoint%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'raw Hive operation evidence cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO checkpoint
      FROM hive_projection.block_checkpoint
     WHERE id = NEW.checkpoint_id;
    IF NOT FOUND
       OR checkpoint.state = 'reverted'
       OR checkpoint.block_number <> NEW.block_number
       OR checkpoint.block_id <> NEW.block_id
       OR checkpoint.block_timestamp <> NEW.block_timestamp THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operation must match its current block checkpoint';
    END IF;
  ELSE
    IF NEW.id <> OLD.id
       OR NEW.checkpoint_id <> OLD.checkpoint_id
       OR NEW.source_operation_id <> OLD.source_operation_id
       OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR NEW.operation_index <> OLD.operation_index
       OR NEW.is_virtual <> OLD.is_virtual
       OR NEW.block_number <> OLD.block_number
       OR NEW.block_id <> OLD.block_id
       OR NEW.block_timestamp <> OLD.block_timestamp
       OR NEW.operation_type <> OLD.operation_type
       OR NEW.primary_account <> OLD.primary_account
       OR NEW.required_authority IS DISTINCT FROM OLD.required_authority
       OR NEW.application_id IS DISTINCT FROM OLD.application_id
       OR NEW.payload <> OLD.payload
       OR NEW.observed_at <> OLD.observed_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'raw Hive operation evidence is immutable';
    END IF;

    IF OLD.state = 'irreversible' AND NEW.state <> 'irreversible' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'irreversible operation cannot be reverted';
    END IF;
    IF OLD.state = 'reverted' AND NEW.state <> 'reverted' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reverted operation must remain historical';
    END IF;
    IF OLD.state <> NEW.state
       AND NOT (OLD.state = 'included' AND NEW.state IN ('irreversible', 'reverted')) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid operation finality transition';
    END IF;
    IF OLD.state = NEW.state AND (
      NEW.irreversible_at IS DISTINCT FROM OLD.irreversible_at
      OR NEW.reverted_at IS DISTINCT FROM OLD.reverted_at
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operation finality evidence is immutable';
    END IF;

    IF OLD.validation_state <> NEW.validation_state
       AND NOT (
         OLD.validation_state = 'pending'
         AND NEW.validation_state IN ('accepted', 'rejected')
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operation validation decision is immutable';
    END IF;
    IF OLD.validation_state = NEW.validation_state AND (
      NEW.validated_at IS DISTINCT FROM OLD.validated_at
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operation validation evidence is immutable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hive_operation_evidence
  BEFORE INSERT OR UPDATE OR DELETE ON hive_projection.operation
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_validate_operation_evidence();

CREATE OR REPLACE FUNCTION hive_projection.hc_check_checkpoint_operation_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row jsonb := to_jsonb(NEW);
  affected_checkpoint_id uuid;
  checkpoint_state hive_projection.operation_state;
BEGIN
  IF TG_TABLE_NAME = 'block_checkpoint' THEN
    affected_checkpoint_id := (source_row ->> 'id')::uuid;
  ELSE
    affected_checkpoint_id := (source_row ->> 'checkpoint_id')::uuid;
  END IF;

  SELECT state INTO checkpoint_state
    FROM hive_projection.block_checkpoint
   WHERE id = affected_checkpoint_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM hive_projection.operation operation
     WHERE operation.checkpoint_id = affected_checkpoint_id
       AND operation.state <> checkpoint_state
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'checkpoint and operation finality states must agree at commit';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_checkpoint_operation_state_from_checkpoint
  AFTER INSERT OR UPDATE ON hive_projection.block_checkpoint
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_checkpoint_operation_state();

CREATE CONSTRAINT TRIGGER trg_checkpoint_operation_state_from_operation
  AFTER INSERT OR UPDATE ON hive_projection.operation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hive_projection.hc_check_checkpoint_operation_state();

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

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
