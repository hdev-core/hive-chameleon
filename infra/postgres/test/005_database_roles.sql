\echo 'non-interchangeable database workload roles'

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF condition IS NOT TRUE THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

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

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 9
      FROM pg_authid
     WHERE rolname IN (
       'hc_api',
       'hc_nakama',
       'hc_provisioning',
       'hc_match_publisher',
       'hc_collectible_issuer',
       'hc_treasury',
       'hc_rc_support',
       'hc_projector',
       'hc_security_auditor'
     )
       AND rolcanlogin = false
       AND rolsuper = false
       AND rolcreatedb = false
       AND rolcreaterole = false
       AND rolinherit = false
       AND rolreplication = false
       AND rolbypassrls = false
       AND rolpassword IS NULL
  ),
  'all nine workload roles have fixed least-privilege attributes'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting setting
      JOIN pg_roles managed_role ON managed_role.oid = setting.setrole
     WHERE managed_role.rolname IN (
       'hc_api',
       'hc_nakama',
       'hc_provisioning',
       'hc_match_publisher',
       'hc_collectible_issuer',
       'hc_treasury',
       'hc_rc_support',
       'hc_projector',
       'hc_security_auditor'
     )
       AND setting.setdatabase IN (
         0,
         (SELECT oid FROM pg_database WHERE datname = current_database())
       )
  ),
  'managed roles have no global or current-database configuration overrides'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hc_worker'),
  'generic worker role does not exist'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
     WHERE member_role.rolname IN (
       'hc_api',
       'hc_nakama',
       'hc_provisioning',
       'hc_match_publisher',
       'hc_collectible_issuer',
       'hc_treasury',
       'hc_rc_support',
       'hc_projector',
       'hc_security_auditor'
     )
  ),
  'managed workload roles cannot inherit or SET ROLE into another role'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'hc_api',
        'hc_nakama',
        'hc_provisioning',
        'hc_match_publisher',
        'hc_collectible_issuer',
        'hc_treasury',
        'hc_rc_support',
        'hc_projector',
        'hc_security_auditor'
      ]) AS managed_role(role_name)
      CROSS JOIN unnest(ARRAY[
        'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
      ]) AS application_schema(schema_name)
     WHERE has_schema_privilege(
       managed_role.role_name,
       application_schema.schema_name,
       'CREATE'
     )
  ),
  'workload roles cannot create application-schema objects'
);

SELECT pg_temp.assert_true(
  has_table_privilege('hc_provisioning', 'identity.hive_account_provisioning', 'UPDATE')
  AND has_column_privilege('hc_match_publisher', 'game.match_publication_outbox', 'state', 'UPDATE')
  AND has_table_privilege('hc_match_publisher', 'identity.player', 'SELECT')
  AND has_schema_privilege('hc_match_publisher', 'identity', 'USAGE')
  AND has_schema_privilege('hc_match_publisher', 'content', 'USAGE')
  AND has_schema_privilege('hc_match_publisher', 'tournament', 'USAGE')
  AND has_table_privilege('hc_match_publisher', 'game.round_participant', 'SELECT')
  AND has_table_privilege('hc_match_publisher', 'content.map_asset', 'SELECT')
  AND has_table_privilege('hc_match_publisher', 'tournament.match_game_round', 'SELECT')
  AND has_column_privilege('hc_match_publisher', 'game.match_publication_outbox', 'updated_at', 'UPDATE')
  AND has_function_privilege('hc_match_publisher', 'public.digest(bytea,text)', 'EXECUTE')
  AND has_table_privilege('hc_collectible_issuer', 'hive_projection.transaction_intent', 'INSERT')
  AND has_column_privilege('hc_collectible_issuer', 'hive_projection.transaction_intent', 'updated_at', 'UPDATE')
  AND has_table_privilege('hc_treasury', 'hive_projection.transaction_intent', 'INSERT')
  AND has_table_privilege('hc_rc_support', 'hive_projection.transaction_intent', 'INSERT')
  AND has_column_privilege('hc_projector', 'commerce.collectible_instance', 'state', 'UPDATE')
  AND has_column_privilege('hc_projector', 'commerce.collectible_instance', 'issued_event_id', 'INSERT')
  AND has_table_privilege('hc_projector', 'hive_projection.block_checkpoint', 'UPDATE'),
  'each workload has its required narrow mutation surface'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege('hc_provisioning', 'identity.platform_role_assignment', 'UPDATE')
  AND NOT has_table_privilege('hc_match_publisher', 'identity.platform_role_assignment', 'UPDATE')
  AND NOT has_table_privilege('hc_collectible_issuer', 'identity.platform_role_assignment', 'UPDATE')
  AND NOT has_table_privilege('hc_treasury', 'identity.platform_role_assignment', 'UPDATE')
  AND NOT has_table_privilege('hc_rc_support', 'identity.platform_role_assignment', 'UPDATE')
  AND NOT has_table_privilege('hc_provisioning', 'commerce.payment_transaction', 'UPDATE')
  AND NOT has_table_privilege('hc_match_publisher', 'commerce.payment_transaction', 'UPDATE')
  AND NOT has_table_privilege('hc_collectible_issuer', 'commerce.payment_transaction', 'UPDATE')
  AND NOT has_table_privilege('hc_treasury', 'identity.auth_session', 'UPDATE')
  AND NOT has_table_privilege('hc_rc_support', 'commerce.payment_transaction', 'UPDATE')
  AND NOT has_table_privilege('hc_provisioning', 'hive_projection.block_checkpoint', 'UPDATE')
  AND NOT has_table_privilege('hc_match_publisher', 'hive_projection.block_checkpoint', 'UPDATE')
  AND NOT has_table_privilege('hc_collectible_issuer', 'hive_projection.block_checkpoint', 'UPDATE')
  AND NOT has_table_privilege('hc_treasury', 'hive_projection.block_checkpoint', 'UPDATE')
  AND NOT has_table_privilege('hc_rc_support', 'hive_projection.block_checkpoint', 'UPDATE'),
  'service roles have no cross-domain or raw-checkpoint mutation grants'
);

SELECT pg_temp.assert_true(
  has_column_privilege(
    'hc_match_publisher',
    'game.match_publication_outbox',
    'state',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'hc_match_publisher',
    'game.match_publication_outbox',
    'canonical_payload',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'hc_match_publisher',
    'game.match_publication_outbox',
    'publisher_hive_account',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'hc_collectible_issuer',
    'hive_projection.transaction_intent',
    'canonical_operation_hash',
    'UPDATE'
  )
  AND has_column_privilege(
    'hc_collectible_issuer',
    'hive_projection.transaction_intent',
    'state',
    'UPDATE'
  )
  AND NOT has_table_privilege('hc_treasury', 'game.match_publication_outbox', 'INSERT')
  AND NOT has_table_privilege('hc_rc_support', 'commerce.collectible_instance', 'INSERT')
  AND NOT has_table_privilege('hc_collectible_issuer', 'tournament.payout', 'UPDATE')
  AND NOT has_column_privilege('hc_projector', 'commerce.collectible_instance', 'owner_player_id', 'UPDATE')
  AND NOT has_column_privilege('hc_projector', 'commerce.collectible_instance', 'issued_event_id', 'UPDATE')
  AND NOT has_table_privilege('hc_projector', 'identity.auth_session', 'SELECT'),
  'role-specific grants do not leak sensitive columns or neighboring service domains'
);

SELECT pg_temp.assert_true(
  (
    SELECT relrowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'hive_projection'
       AND relation.relname = 'transaction_intent'
  )
  AND (
    SELECT count(*) = 8
      FROM pg_policies
     WHERE schemaname = 'hive_projection'
       AND tablename = 'transaction_intent'
  ),
  'shared transaction intents are protected by workload-specific row policies'
);

BEGIN;
SET LOCAL ROLE hc_provisioning;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.platform_role_assignment SET reason = 'forbidden' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE commerce.payment_transaction SET provider_metadata = '{}' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint SET state = 'included' WHERE false$$,
  '42501'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE hc_match_publisher;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.platform_role_assignment SET reason = 'forbidden' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE commerce.payment_transaction SET provider_metadata = '{}' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint SET state = 'included' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE game.match_publication_outbox SET canonical_payload = '{}' WHERE false$$,
  '42501'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE hc_collectible_issuer;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.platform_role_assignment SET reason = 'forbidden' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE commerce.payment_transaction SET provider_metadata = '{}' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint SET state = 'included' WHERE false$$,
  '42501'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE hc_treasury;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.platform_role_assignment SET reason = 'forbidden' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.auth_session SET revoked_at = NULL WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint SET state = 'included' WHERE false$$,
  '42501'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE hc_rc_support;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE identity.platform_role_assignment SET reason = 'forbidden' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE commerce.payment_transaction SET provider_metadata = '{}' WHERE false$$,
  '42501'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.block_checkpoint SET state = 'included' WHERE false$$,
  '42501'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE hc_match_publisher;
INSERT INTO hive_projection.transaction_intent (
  id, idempotency_key, operation_kind, required_authority,
  canonical_operation_hash, authorization_mode, official_service_role,
  allowlist_policy_version, authorization_validated_at, requested_at, expires_at
)
VALUES (
  '01900000-0000-7000-8000-000000000901',
  'role-test-match-publisher',
  'custom_json_match_results',
  'posting',
  repeat('1', 64),
  'official_service',
  'match_publisher',
  'role-test-1',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:05:00Z'
);
COMMIT;

BEGIN;
SET LOCAL ROLE hc_collectible_issuer;
INSERT INTO hive_projection.transaction_intent (
  id, idempotency_key, operation_kind, required_authority,
  canonical_operation_hash, authorization_mode, official_service_role,
  allowlist_policy_version, authorization_validated_at, requested_at, expires_at
)
VALUES (
  '01900000-0000-7000-8000-000000000902',
  'role-test-collectible-issuer',
  'custom_json_collectible',
  'posting',
  repeat('2', 64),
  'official_service',
  'collectible_issuer',
  'role-test-1',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:05:00Z'
);
COMMIT;

BEGIN;
SET LOCAL ROLE hc_treasury;
INSERT INTO hive_projection.transaction_intent (
  id, idempotency_key, operation_kind, required_authority,
  canonical_operation_hash, authorization_mode, official_service_role,
  allowlist_policy_version, authorization_validated_at, requested_at, expires_at
)
VALUES (
  '01900000-0000-7000-8000-000000000903',
  'role-test-treasury',
  'bounded_tournament_payout',
  'active',
  repeat('3', 64),
  'official_service',
  'treasury',
  'role-test-1',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:05:00Z'
);
COMMIT;

BEGIN;
SET LOCAL ROLE hc_rc_support;
INSERT INTO hive_projection.transaction_intent (
  id, idempotency_key, operation_kind, required_authority,
  canonical_operation_hash, authorization_mode, official_service_role,
  allowlist_policy_version, authorization_validated_at, requested_at, expires_at
)
VALUES (
  '01900000-0000-7000-8000-000000000904',
  'role-test-rc-support',
  'delegate_rc_support',
  'posting',
  repeat('4', 64),
  'official_service',
  'rc_support',
  'role-test-1',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:00:00Z',
  '2026-07-16T18:05:00Z'
);
COMMIT;

BEGIN;
SET LOCAL ROLE hc_collectible_issuer;
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO hive_projection.transaction_intent (
      id, idempotency_key, operation_kind, required_authority,
      canonical_operation_hash, authorization_mode, official_service_role,
      allowlist_policy_version, authorization_validated_at, requested_at, expires_at
    ) VALUES (
      '01900000-0000-7000-8000-000000000905',
      'role-test-forged-treasury',
      'bounded_tournament_payout',
      'active',
      repeat('5', 64),
      'official_service',
      'treasury',
      'role-test-1',
      '2026-07-16T18:00:00Z',
      '2026-07-16T18:00:00Z',
      '2026-07-16T18:05:00Z'
    )$$,
  '42501'
);
UPDATE hive_projection.transaction_intent
   SET failure_code = 'cross-role-write'
 WHERE id = '01900000-0000-7000-8000-000000000901';
COMMIT;

SELECT pg_temp.assert_true(
  (
    SELECT failure_code IS NULL
      FROM hive_projection.transaction_intent
     WHERE id = '01900000-0000-7000-8000-000000000901'
  ),
  'one official service cannot see or mutate another service intent'
);
