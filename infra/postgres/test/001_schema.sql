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
    SELECT count(*) = 68
      FROM information_schema.tables
     WHERE table_schema IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
       AND table_type = 'BASE TABLE'
  ),
  'all 68 modeled tables exist'
);

SELECT pg_temp.assert_true(
  has_table_privilege('hc_api', 'identity.hive_login_challenge', 'SELECT')
  AND has_table_privilege('hc_api', 'identity.hive_login_challenge', 'INSERT')
  AND has_table_privilege('hc_api', 'identity.hive_login_challenge', 'UPDATE')
  AND NOT has_table_privilege('hc_nakama', 'identity.hive_login_challenge', 'SELECT'),
  'only the product API can create and consume direct-Hive challenges'
);

SELECT pg_temp.assert_true(
  (
    SELECT is_nullable = 'NO'
       AND column_default = 'false'
      FROM information_schema.columns
     WHERE table_schema = 'game'
       AND table_name = 'lobby_membership'
       AND column_name = 'hunter_nominated'
  ),
  'Hunter nominations are durable non-null membership state'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 5
      FROM information_schema.columns
     WHERE table_schema = 'game'
       AND table_name = 'round_live_checkpoint'
       AND column_name IN (
         'round_id',
         'format_version',
         'private_state',
         'created_at',
         'updated_at'
       )
       AND is_nullable = 'NO'
  ),
  'private live round checkpoints have a versioned object contract'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      FROM content.map
     WHERE slug = 'prism-foundry'
       AND title = 'Chroma District'
       AND origin = 'official'
       AND creator_player_id IS NULL
       AND lifecycle = 'published'
  ),
  'the clean migrated database contains the published Chroma District official map'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      FROM content.map_version version
      JOIN content.map map_definition ON map_definition.id = version.map_id
     WHERE map_definition.slug = 'prism-foundry'
       AND version.version_number = 'm4-4'
       AND version.status = 'published'
       AND version.license_declaration_version = 'official-bundled-provenance-1'
       AND version.manifest ->> 'delivery' = 'bundled_in_game_client'
       AND version.manifest
             #>> '{asset_provenance,environment,raw_source_redistribution}'
           = 'unreviewed_do_not_publish'
  ),
  'the official m4-4 catalog record is explicit without claiming raw source redistribution'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
      FROM content.map_distribution distribution
      JOIN content.map_version version ON version.id = distribution.map_version_id
      JOIN content.map map_definition ON map_definition.id = version.map_id
     WHERE map_definition.slug = 'prism-foundry'
       AND version.version_number = 'm4-4'
       AND distribution.platform IN ('desktop', 'web')
       AND distribution.state = 'available'
       AND distribution.required_game_build_version = 'hive-chameleon-m4-dev'
       AND distribution.required_protocol_version = 'm4-v2'
       AND distribution.published_at IS NOT NULL
  ),
  'Chroma District m4-4 is available for both bundled desktop and web clients'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(DISTINCT type.oid) = 70
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
    SELECT count(*) = 132
      FROM pg_constraint foreign_key
      JOIN pg_class table_class ON table_class.oid = foreign_key.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE foreign_key.contype = 'f'
       AND namespace.nspname IN (
         'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
       )
  ),
  'all modeled foreign keys, including the private live-round checkpoint, exist'
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
  NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE (table_schema = 'game' AND table_name LIKE 'match_publication%')
        OR (table_schema = 'hive_projection' AND table_name IN (
          'match_event', 'match_result', 'match_result_change'
        ))
        OR (table_schema = 'identity' AND table_name LIKE 'public_record_disclosure%')
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'game'
       AND table_name = 'round_result_revision'
       AND column_name = 'canonical_complete_result'
       AND data_type = 'bytea'
       AND is_nullable = 'YES'
  ),
  'local result bytes exist without obsolete publication or disclosure tables'
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
    SELECT count(*) = 8
      FROM pg_roles
     WHERE rolname IN (
       'hc_api', 'hc_nakama', 'hc_provisioning',
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
       'hc_api', 'hc_nakama', 'hc_provisioning',
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
