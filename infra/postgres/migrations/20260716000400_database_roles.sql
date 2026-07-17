-- migrate:up

DO $$
DECLARE
  managed_role text;
  managed_roles text[] := ARRAY[
    'hc_api',
    'hc_nakama',
    'hc_provisioning',
    'hc_match_publisher',
    'hc_collectible_issuer',
    'hc_treasury',
    'hc_rc_support',
    'hc_projector',
    'hc_security_auditor'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hc_worker') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA identity, social, game, content, commerce, tournament, hive_projection FROM hc_worker';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, identity, game, content, hive_projection FROM hc_worker';
    EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA identity, social, game, content, commerce, tournament, hive_projection FROM hc_worker';
    DROP ROLE hc_worker;
  END IF;

  FOREACH managed_role IN ARRAY managed_roles
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = managed_role) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        managed_role
      );
    END IF;

    EXECUTE format(
      'ALTER ROLE %I WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL',
      managed_role
    );
    EXECUTE format('ALTER ROLE %I RESET ALL', managed_role);
    EXECUTE format(
      'ALTER ROLE %I IN DATABASE %I RESET ALL',
      managed_role,
      current_database()
    );

    IF EXISTS (
      SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
       WHERE member_role.rolname = managed_role
    ) THEN
      RAISE EXCEPTION 'managed group role % must not inherit or SET ROLE into another role', managed_role;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
       WHERE owner_role.rolname = managed_role
         AND namespace.nspname IN (
           'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
         )
      UNION ALL
      SELECT 1
        FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        JOIN pg_roles owner_role ON owner_role.oid = function.proowner
       WHERE owner_role.rolname = managed_role
         AND namespace.nspname IN (
           'public', 'identity', 'game', 'content', 'hive_projection'
         )
      UNION ALL
      SELECT 1
        FROM pg_namespace namespace
        JOIN pg_roles owner_role ON owner_role.oid = namespace.nspowner
       WHERE owner_role.rolname = managed_role
         AND namespace.nspname IN (
           'public', 'identity', 'social', 'game', 'content', 'commerce',
           'tournament', 'hive_projection'
         )
      UNION ALL
      SELECT 1
        FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        JOIN pg_roles owner_role ON owner_role.oid = type.typowner
       WHERE owner_role.rolname = managed_role
         AND namespace.nspname IN (
           'identity', 'social', 'game', 'content', 'commerce',
           'tournament', 'hive_projection'
         )
      UNION ALL
      SELECT 1
        FROM pg_database database
        JOIN pg_roles owner_role ON owner_role.oid = database.datdba
       WHERE owner_role.rolname = managed_role
         AND database.datname = current_database()
    ) THEN
      RAISE EXCEPTION 'managed group role % must not own application objects', managed_role;
    END IF;

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA identity, social, game, content, commerce, tournament, hive_projection FROM %I',
      managed_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, identity, game, content, hive_projection FROM %I',
      managed_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA identity, social, game, content, commerce, tournament, hive_projection FROM %I',
      managed_role
    );
  END LOOP;
END;
$$;

REVOKE ALL ON SCHEMA identity, social, game, content, commerce, tournament, hive_projection
  FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA
  identity, social, game, content, commerce, tournament, hive_projection
  FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public, identity, game, content, hive_projection
  FROM PUBLIC;

GRANT USAGE ON SCHEMA identity, social, game, content, commerce, tournament, hive_projection
  TO hc_api;
GRANT USAGE ON SCHEMA identity, game, content TO hc_nakama;
GRANT USAGE ON SCHEMA identity, hive_projection TO hc_provisioning, hc_rc_support;
GRANT USAGE ON SCHEMA game, hive_projection TO hc_match_publisher;
GRANT USAGE ON SCHEMA identity, game, commerce, hive_projection TO hc_collectible_issuer;
GRANT USAGE ON SCHEMA identity, commerce, tournament, hive_projection TO hc_treasury;
GRANT USAGE ON SCHEMA identity, game, content, commerce, tournament, hive_projection
  TO hc_projector;
GRANT USAGE ON SCHEMA identity TO hc_security_auditor;

GRANT SELECT, INSERT, UPDATE ON
  identity.player,
  identity.external_identity,
  identity.public_record_disclosure_acknowledgment,
  identity.player_profile,
  identity.auth_session,
  identity.player_preference,
  identity.player_platform_setting,
  identity.player_appearance,
  identity.platform_role_approval,
  identity.platform_role_assignment,
  identity.authorization_audit_event,
  social.friend_request,
  social.friendship,
  social.player_block,
  social.lobby_invitation,
  social.notification,
  content.map,
  content.map_version,
  content.map_lifecycle_event,
  content.map_asset,
  content.map_review,
  content.tag,
  content.map_tag,
  content.map_distribution,
  content.map_showcase,
  commerce.collectible_definition,
  commerce.collectible_asset,
  commerce.player_loadout,
  commerce.shop_offer,
  commerce.shop_offer_price,
  commerce.payment_transaction,
  commerce.purchase,
  tournament.tournament,
  tournament.tournament_entry,
  tournament.prize_rule,
  tournament.tournament_match,
  tournament.match_entry,
  tournament.match_game_round,
  tournament.entry_score,
  tournament.payout
  TO hc_api;
GRANT SELECT, INSERT ON
  identity.hive_account_provisioning,
  identity.hive_account_claim
  TO hc_api;
GRANT SELECT ON
  identity.custody_key_reference,
  identity.public_record_disclosure,
  commerce.collectible_instance
  TO hc_api;
GRANT SELECT ON
  game.lobby,
  game.lobby_access_token,
  game.lobby_membership,
  game.lobby_host_assignment,
  game.lobby_configuration,
  game.game_round,
  game.round_participant,
  game.round_discovery,
  game.round_disguise_snapshot,
  game.round_like,
  game.round_result_revision,
  game.match_publication_request,
  game.match_publication_outbox,
  game.match_publication_item,
  game.player_mode_stat,
  game.achievement_definition,
  game.player_achievement,
  hive_projection.block_checkpoint,
  hive_projection.operation,
  hive_projection.match_event,
  hive_projection.match_result,
  hive_projection.match_result_change,
  hive_projection.collectible_event,
  hive_projection.asset_transfer,
  hive_projection.community_post,
  hive_projection.community_vote,
  hive_projection.transaction_intent,
  hive_projection.rc_delegation,
  hive_projection.sync_cursor
  TO hc_api;

GRANT SELECT ON identity.player, identity.public_record_disclosure,
  identity.public_record_disclosure_acknowledgment TO hc_nakama;
GRANT SELECT ON content.map, content.map_version, content.map_asset,
  content.map_distribution TO hc_nakama;
GRANT SELECT, INSERT, UPDATE ON
  game.lobby,
  game.lobby_membership,
  game.lobby_host_assignment,
  game.lobby_configuration,
  game.game_round,
  game.round_participant,
  game.round_discovery,
  game.round_disguise_snapshot,
  game.round_like
  TO hc_nakama;
GRANT SELECT, INSERT ON
  game.round_result_revision,
  game.match_publication_request
  TO hc_nakama;

GRANT SELECT, INSERT, UPDATE ON
  identity.external_identity,
  identity.hive_account_provisioning,
  identity.custody_key_reference,
  identity.hive_account_claim,
  identity.player
  TO hc_provisioning;
GRANT SELECT, UPDATE ON identity.auth_session TO hc_provisioning;
GRANT SELECT ON
  identity.public_record_disclosure,
  identity.public_record_disclosure_acknowledgment,
  hive_projection.operation,
  hive_projection.rc_delegation
  TO hc_provisioning;

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
  game.player_achievement,
  commerce.collectible_definition,
  commerce.collectible_asset,
  commerce.collectible_instance,
  commerce.purchase
  TO hc_collectible_issuer;

GRANT SELECT ON
  identity.player,
  commerce.payment_transaction,
  tournament.tournament,
  tournament.tournament_entry,
  tournament.prize_rule,
  tournament.entry_score,
  tournament.payout
  TO hc_treasury;

GRANT SELECT ON
  identity.player,
  hive_projection.operation,
  hive_projection.rc_delegation
  TO hc_rc_support;

GRANT SELECT, INSERT ON hive_projection.transaction_intent
  TO hc_api, hc_provisioning, hc_match_publisher, hc_collectible_issuer, hc_treasury, hc_rc_support;
GRANT UPDATE (state, hive_transaction_id, failure_code)
  ON hive_projection.transaction_intent
  TO hc_api, hc_provisioning, hc_match_publisher, hc_collectible_issuer, hc_treasury, hc_rc_support;

GRANT SELECT ON
  identity.player,
  identity.hive_account_provisioning,
  game.game_round,
  game.round_result_revision,
  content.map,
  content.map_version,
  content.map_asset,
  commerce.collectible_definition,
  commerce.collectible_instance,
  commerce.payment_transaction,
  tournament.tournament,
  tournament.tournament_entry,
  tournament.payout
  TO hc_projector;
GRANT SELECT, INSERT, UPDATE ON
  hive_projection.block_checkpoint,
  hive_projection.operation,
  hive_projection.match_event,
  hive_projection.match_result,
  hive_projection.match_result_change,
  hive_projection.collectible_event,
  hive_projection.asset_transfer,
  hive_projection.community_post,
  hive_projection.community_vote,
  hive_projection.rc_delegation,
  hive_projection.sync_cursor
  TO hc_projector;

GRANT SELECT ON identity.authorization_audit_event TO hc_security_auditor;

GRANT EXECUTE ON FUNCTION public.hc_is_uuid_v7(uuid), public.hc_is_sha256(text)
  TO hc_api, hc_nakama, hc_provisioning, hc_match_publisher,
     hc_collectible_issuer, hc_treasury, hc_rc_support, hc_projector;
GRANT EXECUTE ON FUNCTION public.hc_role_assignment_key(
  uuid, identity.platform_role, identity.role_scope_type, uuid
) TO hc_api;
GRANT EXECUTE ON FUNCTION identity.hc_validate_role_scope(identity.role_scope_type, uuid)
  TO hc_api;
GRANT EXECUTE ON FUNCTION
  hive_projection.hc_match_result_expected_head(uuid, uuid),
  hive_projection.hc_assert_stored_match_result_head(uuid)
  TO hc_projector;

ALTER TABLE hive_projection.transaction_intent ENABLE ROW LEVEL SECURITY;

CREATE POLICY transaction_intent_api_read
  ON hive_projection.transaction_intent
  FOR SELECT TO hc_api
  USING (true);

CREATE POLICY transaction_intent_api_player_insert
  ON hive_projection.transaction_intent
  FOR INSERT TO hc_api
  WITH CHECK (
    authorization_mode IN ('external_wallet', 'custodial_player')
    AND official_service_role IS NULL
  );

CREATE POLICY transaction_intent_api_player_update
  ON hive_projection.transaction_intent
  FOR UPDATE TO hc_api
  USING (
    authorization_mode IN ('external_wallet', 'custodial_player')
    AND official_service_role IS NULL
  )
  WITH CHECK (
    authorization_mode IN ('external_wallet', 'custodial_player')
    AND official_service_role IS NULL
  );

CREATE POLICY transaction_intent_provisioning
  ON hive_projection.transaction_intent
  FOR ALL TO hc_provisioning
  USING (
    authorization_mode = 'custodial_player'
    AND official_service_role IS NULL
  )
  WITH CHECK (
    authorization_mode = 'custodial_player'
    AND official_service_role IS NULL
  );

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

CREATE POLICY transaction_intent_collectible_issuer
  ON hive_projection.transaction_intent
  FOR ALL TO hc_collectible_issuer
  USING (
    authorization_mode = 'official_service'
    AND official_service_role = 'collectible_issuer'
  )
  WITH CHECK (
    authorization_mode = 'official_service'
    AND official_service_role = 'collectible_issuer'
  );

CREATE POLICY transaction_intent_treasury
  ON hive_projection.transaction_intent
  FOR ALL TO hc_treasury
  USING (
    authorization_mode = 'official_service'
    AND official_service_role = 'treasury'
  )
  WITH CHECK (
    authorization_mode = 'official_service'
    AND official_service_role = 'treasury'
  );

CREATE POLICY transaction_intent_rc_support
  ON hive_projection.transaction_intent
  FOR ALL TO hc_rc_support
  USING (
    authorization_mode = 'official_service'
    AND official_service_role = 'rc_support'
  )
  WITH CHECK (
    authorization_mode = 'official_service'
    AND official_service_role = 'rc_support'
  );

REVOKE UPDATE, DELETE ON identity.authorization_audit_event
  FROM hc_api, hc_nakama, hc_provisioning, hc_match_publisher,
       hc_collectible_issuer, hc_treasury, hc_rc_support,
       hc_projector, hc_security_auditor;
REVOKE UPDATE, DELETE ON game.round_result_revision,
  content.map_lifecycle_event,
  content.map_review,
  hive_projection.match_result_change
  FROM hc_api, hc_nakama, hc_provisioning, hc_match_publisher,
       hc_collectible_issuer, hc_treasury, hc_rc_support, hc_projector;

-- Deployments grant exactly one of these group roles to each distinct LOGIN/workload identity.
-- No password, signer, sponsor, custody, or database-superuser credential belongs here.

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
