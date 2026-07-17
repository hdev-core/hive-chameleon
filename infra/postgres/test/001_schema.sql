\echo 'schema inventory and migration contract'

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

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 7
      FROM information_schema.schemata
     WHERE schema_name IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
  ),
  'seven application schemas exist'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 74
      FROM information_schema.tables
     WHERE table_schema IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
       AND table_type = 'BASE TABLE'
  ),
  'all 74 modeled tables exist'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(DISTINCT type.oid) = 77
      FROM pg_type type
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      JOIN pg_enum enum_value ON enum_value.enumtypid = type.oid
     WHERE namespace.nspname IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
  ),
  'all modeled lifecycle enums exist'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 154
      FROM pg_constraint foreign_key
      JOIN pg_class table_class ON table_class.oid = foreign_key.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE foreign_key.contype = 'f'
       AND namespace.nspname IN (
         'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
       )
  ),
  'all modeled foreign keys exist'
);

SELECT pg_temp.assert_true(
  (
    SELECT bool_and(installed_version IS NOT NULL)
      FROM pg_available_extensions
     WHERE name IN ('pgcrypto', 'btree_gist')
  ),
  'required extensions are installed'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint primary_key
      JOIN pg_class table_class ON table_class.oid = primary_key.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_attribute column_attribute
        ON column_attribute.attrelid = table_class.oid
       AND column_attribute.attnum = primary_key.conkey[1]
     WHERE primary_key.contype = 'p'
       AND cardinality(primary_key.conkey) = 1
       AND column_attribute.atttypid = 'uuid'::regtype
       AND namespace.nspname IN (
         'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM pg_constraint uuid_check
          WHERE uuid_check.conrelid = table_class.oid
            AND uuid_check.contype = 'c'
            AND pg_get_constraintdef(uuid_check.oid) LIKE '%hc_is_uuid_v7%'
       )
  ),
  'every single-column UUID primary key enforces UUIDv7'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 6
      FROM pg_indexes
     WHERE indexname IN (
       'uq_auth_session_one_open_per_player',
       'uq_lobby_membership_one_open_per_player',
       'uq_lobby_one_current_host_assignment',
       'uq_block_checkpoint_current_height',
       'uq_hive_operation_current_source_id',
       'uq_hive_operation_current_tx_index'
     )
       AND indexdef LIKE '% WHERE %'
  ),
  'critical partial and fork-current indexes exist'
);

SELECT pg_temp.assert_true(
  (
    SELECT is_nullable = 'YES'
      FROM information_schema.columns
     WHERE table_schema = 'hive_projection'
       AND table_name = 'match_event'
       AND column_name = 'batch_uuid'
  ),
  'correction and invalidation events do not invent a batch id'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 4
      FROM information_schema.columns
     WHERE table_schema = 'hive_projection'
       AND table_name = 'operation'
       AND column_name IN ('checkpoint_id', 'validation_state', 'rejection_reason', 'validated_at')
  ),
  'operation evidence has checkpoint and validation fields'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 9
      FROM pg_roles
     WHERE rolname IN (
       'hc_api', 'hc_nakama', 'hc_provisioning', 'hc_match_publisher',
       'hc_collectible_issuer', 'hc_treasury', 'hc_rc_support',
       'hc_projector', 'hc_security_auditor'
     )
       AND rolcanlogin = false
       AND rolsuper = false
       AND rolcreatedb = false
       AND rolcreaterole = false
       AND rolinherit = false
       AND rolreplication = false
       AND rolbypassrls = false
  ),
  'database defense-in-depth roles have fixed least-privilege attributes'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
     WHERE member_role.rolname IN (
       'hc_api', 'hc_nakama', 'hc_provisioning', 'hc_match_publisher',
       'hc_collectible_issuer', 'hc_treasury', 'hc_rc_support',
       'hc_projector', 'hc_security_auditor'
     )
  ),
  'managed group roles cannot inherit or SET ROLE into another role'
);

SELECT pg_temp.assert_true(
  has_table_privilege('hc_projector', 'hive_projection.operation', 'INSERT')
  AND NOT has_table_privilege('hc_projector', 'identity.auth_session', 'INSERT'),
  'projection role cannot mutate identity sessions'
);
