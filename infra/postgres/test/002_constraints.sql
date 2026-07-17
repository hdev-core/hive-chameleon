\echo 'UUID, authorization, partial-index, and fork constraints'

CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(statement text, expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  caught_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS caught_state = RETURNED_SQLSTATE;
    IF caught_state <> expected_state THEN
      RAISE EXCEPTION 'expected SQLSTATE %, got % for %', expected_state, caught_state, statement;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected SQLSTATE %, statement succeeded: %', expected_state, statement;
END;
$$;

INSERT INTO identity.player (id, hive_username, hive_control_state)
VALUES
  ('01900000-0000-7000-8000-000000000001', 'admin-one', 'external_self_custodial'),
  ('01900000-0000-7000-8000-000000000002', 'admin-two', 'external_self_custodial'),
  ('01900000-0000-7000-8000-000000000003', 'operator', 'external_self_custodial');

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO identity.player (id, hive_username, hive_control_state)
    VALUES ('550e8400-e29b-41d4-a716-446655440000', 'uuid-four', 'external_self_custodial')$$,
  '23514'
);

INSERT INTO identity.auth_session (
  id, player_id, refresh_token_hash, platform, authentication_method,
  hive_control_state_at_issue, issued_at, expires_at
)
VALUES (
  '01900000-0000-7000-8000-000000000010',
  '01900000-0000-7000-8000-000000000002',
  repeat('1', 64),
  'linux',
  'direct_hive_challenge',
  'external_self_custodial',
  '2026-07-16T10:00:00Z',
  '2026-08-16T10:00:00Z'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO identity.auth_session (
      id, player_id, refresh_token_hash, platform, authentication_method,
      hive_control_state_at_issue, issued_at, expires_at
    ) VALUES (
      '01900000-0000-7000-8000-000000000011',
      '01900000-0000-7000-8000-000000000002',
      repeat('2', 64), 'linux', 'direct_hive_challenge',
      'external_self_custodial', '2026-07-16T10:00:00Z', '2026-08-16T10:00:00Z'
    )$$,
  '23505'
);

INSERT INTO identity.authorization_audit_event (
  id, actor_type, actor_player_id, decision, action, subject_player_id,
  role, scope_type, correlation_id, reason_code
)
VALUES (
  '01900000-0000-7000-8000-000000000101',
  'player',
  '01900000-0000-7000-8000-000000000001',
  'grant',
  'platform_role.grant',
  '01900000-0000-7000-8000-000000000003',
  'platform_administrator',
  'platform',
  '01900000-0000-7000-8000-000000000111',
  'approved_staff_assignment'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO identity.platform_role_assignment (
      id, player_id, role, scope_type, valid_from, valid_until,
      granted_by_player_id, grant_audit_event_id, reason
    ) VALUES (
      '01900000-0000-7000-8000-000000000103',
      '01900000-0000-7000-8000-000000000003',
      'platform_administrator', 'platform',
      '2026-07-16T12:00:00Z', '2026-08-16T12:00:00Z',
      '01900000-0000-7000-8000-000000000001',
      '01900000-0000-7000-8000-000000000101',
      'time-boxed administration'
    )$$,
  '23514'
);

INSERT INTO identity.platform_role_approval (
  id, target_player_id, role, scope_type, valid_from, valid_until,
  requested_by_player_id, approved_by_player_id, state, reason,
  requested_at, expires_at, decided_at
)
VALUES (
  '01900000-0000-7000-8000-000000000102',
  '01900000-0000-7000-8000-000000000003',
  'platform_administrator',
  'platform',
  '2026-07-16T12:00:00Z',
  '2026-08-16T12:00:00Z',
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  'approved',
  'independent production approval',
  '2026-07-16T11:00:00Z',
  '2099-07-17T11:00:00Z',
  '2026-07-16T11:30:00Z'
);

INSERT INTO identity.platform_role_assignment (
  id, player_id, role, scope_type, valid_from, valid_until,
  granted_by_player_id, approval_id, grant_audit_event_id, reason
)
VALUES (
  '01900000-0000-7000-8000-000000000103',
  '01900000-0000-7000-8000-000000000003',
  'platform_administrator',
  'platform',
  '2026-07-16T12:00:00Z',
  '2026-08-16T12:00:00Z',
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000102',
  '01900000-0000-7000-8000-000000000101',
  'time-boxed administration'
);

SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.authorization_audit_event
       SET reason_code = 'rewritten'
     WHERE id = '01900000-0000-7000-8000-000000000101'$$,
  '55000'
);

INSERT INTO identity.authorization_audit_event (
  id, actor_type, actor_player_id, decision, action, subject_player_id,
  role, scope_type, correlation_id, reason_code
)
VALUES (
  '01900000-0000-7000-8000-000000000104',
  'player',
  '01900000-0000-7000-8000-000000000002',
  'revoke',
  'platform_role.revoke',
  '01900000-0000-7000-8000-000000000003',
  'platform_administrator',
  'platform',
  '01900000-0000-7000-8000-000000000114',
  'assignment_ended'
);

UPDATE identity.platform_role_assignment
   SET revoked_at = '2026-07-20T12:00:00Z',
       revoked_by_player_id = '01900000-0000-7000-8000-000000000002',
       revocation_reason = 'assignment ended',
       revocation_audit_event_id = '01900000-0000-7000-8000-000000000104'
 WHERE id = '01900000-0000-7000-8000-000000000103';

INSERT INTO hive_projection.block_checkpoint (
  id, source, block_number, block_id, previous_block_id, block_timestamp, state
)
VALUES (
  '01900000-0000-7000-8000-000000000201',
  'hafah-primary', 100, '00000064aaaa', '00000063aaaa', '2026-07-16T12:00:00Z', 'included'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO hive_projection.block_checkpoint (
      id, source, block_number, block_id, previous_block_id, block_timestamp, state
    ) VALUES (
      '01900000-0000-7000-8000-000000000202',
      'hafah-primary', 100, '00000064bbbb', '00000063aaaa', '2026-07-16T12:00:01Z', 'included'
    )$$,
  '23505'
);

UPDATE hive_projection.block_checkpoint
   SET state = 'reverted', reverted_at = '2026-07-16T12:01:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000201';

INSERT INTO hive_projection.block_checkpoint (
  id, source, block_number, block_id, previous_block_id, block_timestamp, state
)
VALUES (
  '01900000-0000-7000-8000-000000000202',
  'hafah-primary', 100, '00000064bbbb', '00000063aaaa', '2026-07-16T12:00:01Z', 'included'
);

UPDATE hive_projection.block_checkpoint
   SET state = 'irreversible', irreversible_at = '2026-07-16T12:02:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000202';

SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint
       SET state = 'reverted', reverted_at = '2026-07-16T12:03:00Z'
     WHERE id = '01900000-0000-7000-8000-000000000202'$$,
  '55000'
);

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, required_authority, application_id, payload, state,
  validation_state, validated_at, irreversible_at
)
VALUES (
  '01900000-0000-7000-8000-000000000301',
  '01900000-0000-7000-8000-000000000202',
  '12345678901234567890', 'abc123', 0, false, 100, '00000064bbbb',
  '2026-07-16T12:00:01Z', 'custom_json', 'publisher', 'posting',
  'hive.chameleon',
  jsonb_build_object(
    'required_auths', '[]'::jsonb,
    'required_posting_auths', jsonb_build_array('publisher'),
    'id', 'hive.chameleon',
    'json', jsonb_build_object(
      'v', 1,
      'type', 'match_result_corrected',
      'event_version', 1,
      'event_id', '01900000-0000-7000-8000-000000000401',
      'data', jsonb_build_object('publisher', 'publisher')
    )::text
  ),
  'irreversible', 'accepted',
  '2026-07-16T12:02:00Z', '2026-07-16T12:02:00Z'
);

INSERT INTO hive_projection.match_event (
  event_uuid, operation_id, event_type, schema_version, event_contract_version,
  publisher_hive_account, result_count, operation_state, validation_state,
  included_at, irreversible_at
)
VALUES (
  '01900000-0000-7000-8000-000000000401',
  '01900000-0000-7000-8000-000000000301',
  'match_result_corrected', 1, 'match-event-1', 'publisher', 1,
  'irreversible', 'accepted', '2026-07-16T12:00:01Z', '2026-07-16T12:02:00Z'
);

SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.operation
       SET validation_state = 'rejected', rejection_reason = 'decision_rewrite'
     WHERE id = '01900000-0000-7000-8000-000000000301'$$,
  '55000'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO hive_projection.match_event (
      event_uuid, operation_id, event_type, schema_version, event_contract_version,
      publisher_hive_account, result_count, operation_state, validation_state, included_at
    ) VALUES (
      '01900000-0000-7000-8000-000000000402',
      '01900000-0000-7000-8000-000000000301',
      'match_results_batch', 1, 'match-event-1', 'publisher', 1,
      'included', 'accepted', '2026-07-16T12:00:01Z'
    )$$,
  '23514'
);

INSERT INTO hive_projection.block_checkpoint (
  id, source, block_number, block_id, previous_block_id, block_timestamp, state
)
VALUES (
  '01900000-0000-7000-8000-000000000203',
  'hafah-primary', 101, '00000065bbbb', '00000064bbbb', '2026-07-16T12:03:00Z', 'included'
);

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, required_authority, application_id, payload, state
)
VALUES (
  '01900000-0000-7000-8000-000000000302',
  '01900000-0000-7000-8000-000000000203',
  '12345678901234567891', 'def456', 0, false, 101, '00000065bbbb',
  '2026-07-16T12:03:00Z', 'custom_json', 'publisher', 'posting',
  'hive.chameleon',
  jsonb_build_object(
    'required_auths', '[]'::jsonb,
    'required_posting_auths', jsonb_build_array('publisher'),
    'id', 'hive.chameleon',
    'json', jsonb_build_object(
      'v', 1,
      'type', 'match_result_corrected',
      'event_version', 1,
      'event_id', '01900000-0000-7000-8000-000000000403',
      'data', jsonb_build_object('publisher', 'publisher')
    )::text
  ),
  'included'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO hive_projection.match_event (
      event_uuid, operation_id, event_type, schema_version, event_contract_version,
      publisher_hive_account, result_count, operation_state, validation_state, included_at
    ) VALUES (
      '01900000-0000-7000-8000-000000000403',
      '01900000-0000-7000-8000-000000000302',
      'match_result_corrected', 1, 'match-event-1', 'publisher', 1,
      'included', 'accepted', '2026-07-16T12:03:00Z'
    )$$,
  '23514'
);

BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint
       SET state = 'irreversible', irreversible_at = '2026-07-16T12:04:00Z'
     WHERE id = '01900000-0000-7000-8000-000000000203'$$,
  '23514'
);
ROLLBACK;

UPDATE hive_projection.operation
   SET validation_state = 'accepted', validated_at = '2026-07-16T12:03:30Z'
 WHERE id = '01900000-0000-7000-8000-000000000302';

INSERT INTO hive_projection.match_event (
  event_uuid, operation_id, event_type, schema_version, event_contract_version,
  publisher_hive_account, result_count, operation_state, validation_state, included_at
)
VALUES (
  '01900000-0000-7000-8000-000000000403',
  '01900000-0000-7000-8000-000000000302',
  'match_result_corrected', 1, 'match-event-1', 'publisher', 1,
  'included', 'accepted', '2026-07-16T12:03:00Z'
);

BEGIN;
UPDATE hive_projection.block_checkpoint
   SET state = 'reverted', reverted_at = '2026-07-16T12:04:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000203';
UPDATE hive_projection.operation
   SET state = 'reverted', reverted_at = '2026-07-16T12:04:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000302';
UPDATE hive_projection.match_event
   SET operation_state = 'reverted',
       validation_state = 'reverted',
       reverted_at = '2026-07-16T12:04:00Z'
 WHERE event_uuid = '01900000-0000-7000-8000-000000000403';
COMMIT;

INSERT INTO hive_projection.block_checkpoint (
  id, source, block_number, block_id, previous_block_id, block_timestamp, state
)
VALUES (
  '01900000-0000-7000-8000-000000000204',
  'hafah-primary', 101, '00000065cccc', '00000064bbbb', '2026-07-16T12:05:00Z', 'included'
);

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, required_authority, application_id, payload, state,
  validation_state, validated_at
)
VALUES (
  '01900000-0000-7000-8000-000000000303',
  '01900000-0000-7000-8000-000000000204',
  '12345678901234567891', 'def456', 0, false, 101, '00000065cccc',
  '2026-07-16T12:05:00Z', 'custom_json', 'publisher', 'posting',
  'hive.chameleon',
  jsonb_build_object(
    'required_auths', '[]'::jsonb,
    'required_posting_auths', jsonb_build_array('publisher'),
    'id', 'hive.chameleon',
    'json', jsonb_build_object(
      'v', 1,
      'type', 'match_result_corrected',
      'event_version', 1,
      'event_id', '01900000-0000-7000-8000-000000000403',
      'data', jsonb_build_object('publisher', 'publisher')
    )::text
  ),
  'included', 'accepted', '2026-07-16T12:05:30Z'
);

UPDATE hive_projection.match_event
   SET operation_id = '01900000-0000-7000-8000-000000000303',
       operation_state = 'included',
       validation_state = 'accepted',
       included_at = '2026-07-16T12:05:00Z',
       reverted_at = NULL
 WHERE event_uuid = '01900000-0000-7000-8000-000000000403';

SELECT pg_temp.assert_true(
  (
    SELECT operation_id = '01900000-0000-7000-8000-000000000303'
       AND operation_state = 'included'
       AND validation_state = 'accepted'
       AND reverted_at IS NULL
      FROM hive_projection.match_event
     WHERE event_uuid = '01900000-0000-7000-8000-000000000403'
  ),
  'stable match event rebinds only to identical accepted evidence after a fork'
);

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, payload, state
)
VALUES
  (
    '01900000-0000-7000-8000-000000000306',
    '01900000-0000-7000-8000-000000000204',
    '12345678901234567895', 'def456', 3, true, 101, '00000065cccc',
    '2026-07-16T12:05:00Z', 'changed_recovery_account_operation',
    'player-one', '{}', 'included'
  ),
  (
    '01900000-0000-7000-8000-000000000307',
    '01900000-0000-7000-8000-000000000204',
    '12345678901234567896', NULL, 4, true, 101, '00000065cccc',
    '2026-07-16T12:05:00Z', 'producer_reward_operation',
    'witness-one', '{}', 'included'
  );

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
      FROM hive_projection.operation
     WHERE id IN (
       '01900000-0000-7000-8000-000000000306',
       '01900000-0000-7000-8000-000000000307'
     )
       AND is_virtual
  ),
  'virtual operation evidence accepts either an originating transaction id or no transaction id'
);
