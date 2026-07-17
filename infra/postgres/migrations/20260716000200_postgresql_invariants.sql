-- migrate:up

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hc_is_uuid_v7(value uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT (get_byte(uuid_send(value), 6) >> 4) = 7
     AND (get_byte(uuid_send(value), 8) >> 6) = 2;
$$;

CREATE OR REPLACE FUNCTION public.hc_is_sha256(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT value ~ '^[0-9a-f]{64}$';
$$;

CREATE OR REPLACE FUNCTION public.hc_role_assignment_key(
  player_id uuid,
  role identity.platform_role,
  scope_type identity.role_scope_type,
  scope_id uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT player_id::text || '/' || role::text || '/' || scope_type::text || '/' ||
         COALESCE(scope_id::text, '-');
$$;

COMMENT ON FUNCTION public.hc_is_uuid_v7(uuid) IS
  'Checks RFC 9562 UUID version and variant bits; generation remains application-owned.';
COMMENT ON FUNCTION public.hc_is_sha256(text) IS
  'Checks the normalized lowercase hexadecimal representation of a SHA-256 digest.';

DO $$
DECLARE
  target record;
  constraint_name text;
BEGIN
  FOR target IN
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name
      FROM pg_constraint p
      JOIN pg_class c ON c.oid = p.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attnum = p.conkey[1]
     WHERE p.contype = 'p'
       AND cardinality(p.conkey) = 1
       AND a.atttypid = 'uuid'::regtype
       AND n.nspname IN (
         'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
       )
  LOOP
    constraint_name := left(
      format('chk_%s_%s_uuid_v7', target.table_name, target.column_name),
      63
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (public.hc_is_uuid_v7(%I))',
      target.schema_name,
      target.table_name,
      constraint_name,
      target.column_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  target record;
  constraint_name text;
BEGIN
  FOR target IN
    SELECT table_schema AS schema_name,
           table_name,
           column_name
      FROM information_schema.columns
     WHERE table_schema IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
       AND column_name LIKE '%sha256'
  LOOP
    constraint_name := left(
      format('chk_%s_%s_hex', target.table_name, target.column_name),
      63
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR public.hc_is_sha256(%I::text))',
      target.schema_name,
      target.table_name,
      constraint_name,
      target.column_name,
      target.column_name
    );
  END LOOP;
END;
$$;

ALTER TABLE game.match_publication_outbox
  ADD CONSTRAINT chk_match_outbox_payload_sha256
  CHECK (
    encode(digest(convert_to(canonical_payload, 'UTF8'), 'sha256'), 'hex') = payload_sha256
  );

CREATE UNIQUE INDEX uq_provisioning_reserved_username
    ON identity.hive_account_provisioning (requested_hive_username)
    WHERE state <> 'terminal_failed'::identity.provisioning_state
       OR account_observed_at IS NOT NULL;

CREATE UNIQUE INDEX uq_custody_key_current_provisioning_role
    ON identity.custody_key_reference (provisioning_id, authority_role)
    WHERE state IN (
        'generated'::identity.custody_key_state,
        'active'::identity.custody_key_state,
        'destruction_requested'::identity.custody_key_state
    );

CREATE UNIQUE INDEX uq_custody_key_current_player_role
    ON identity.custody_key_reference (player_id, authority_role)
    WHERE player_id IS NOT NULL
      AND state IN (
          'generated'::identity.custody_key_state,
          'active'::identity.custody_key_state,
          'destruction_requested'::identity.custody_key_state
      );

CREATE UNIQUE INDEX uq_hive_account_claim_one_pending_player
    ON identity.hive_account_claim (player_id)
    WHERE state IN (
        'requested'::identity.claim_state,
        'authority_rotation_pending'::identity.claim_state,
        'custody_destruction_pending'::identity.claim_state,
        'recovery_change_pending'::identity.claim_state,
        'retryable_failed'::identity.claim_state
    );

CREATE UNIQUE INDEX uq_disclosure_ack_external_version
    ON identity.public_record_disclosure_acknowledgment
       (external_identity_id, disclosure_version)
    WHERE external_identity_id IS NOT NULL;

CREATE UNIQUE INDEX uq_disclosure_ack_player_version
    ON identity.public_record_disclosure_acknowledgment
       (player_id, disclosure_version)
    WHERE player_id IS NOT NULL;

CREATE UNIQUE INDEX uq_auth_session_one_open_per_player
    ON identity.auth_session (player_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX uq_lobby_membership_one_open_per_player
    ON game.lobby_membership (player_id)
    WHERE left_at IS NULL;

CREATE UNIQUE INDEX uq_lobby_one_current_host_assignment
    ON game.lobby_host_assignment (lobby_id)
    WHERE ended_at IS NULL;

CREATE UNIQUE INDEX uq_friend_request_one_pending_pair
    ON social.friend_request (
        LEAST(requester_player_id, recipient_player_id),
        GREATEST(requester_player_id, recipient_player_id)
    )
    WHERE status = 'pending'::social.friend_request_status;

CREATE UNIQUE INDEX uq_lobby_invitation_one_pending_invitee
    ON social.lobby_invitation (lobby_id, invitee_player_id)
    WHERE status = 'pending'::social.invitation_status;

CREATE INDEX idx_lobby_open_public_region
    ON game.lobby (region_code, created_at DESC)
    WHERE closed_at IS NULL
      AND visibility = 'public'::game.lobby_visibility;

CREATE UNIQUE INDEX uq_map_version_one_package
    ON content.map_asset (map_version_id)
    WHERE kind = 'package'::content.map_asset_kind;

CREATE UNIQUE INDEX uq_loadout_one_active_item_per_slot
    ON commerce.player_loadout (player_id, equipment_slot)
    WHERE unequipped_at IS NULL;

CREATE UNIQUE INDEX uq_loadout_one_active_use_per_instance
    ON commerce.player_loadout (collectible_instance_id)
    WHERE unequipped_at IS NULL;

CREATE UNIQUE INDEX uq_payment_one_open_correlation
    ON commerce.payment_transaction (correlation_reference)
    WHERE correlation_reference IS NOT NULL
      AND state IN (
          'requested'::commerce.payment_state,
          'awaiting_signature'::commerce.payment_state,
          'broadcast'::commerce.payment_state,
          'included'::commerce.payment_state
      );

CREATE UNIQUE INDEX uq_match_publication_one_initial_round
    ON game.match_publication_request (round_id)
    WHERE request_type = 'initial'::game.match_publication_request_type
      AND state <> 'cancelled'::game.match_publication_request_state;

CREATE UNIQUE INDEX uq_rc_delegation_one_active_scope
    ON hive_projection.rc_delegation
       (delegator_hive_account, recipient_hive_username, purpose)
    WHERE status IN (
        'pending'::hive_projection.rc_delegation_status,
        'active'::hive_projection.rc_delegation_status,
        'reclaiming'::hive_projection.rc_delegation_status
    );

CREATE UNIQUE INDEX uq_block_checkpoint_current_height
    ON hive_projection.block_checkpoint (source, block_number)
    WHERE state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_hive_operation_current_source_id
    ON hive_projection.operation (source_operation_id)
    WHERE state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_hive_operation_current_tx_index
    ON hive_projection.operation (transaction_id, operation_index)
    WHERE transaction_id IS NOT NULL
      AND state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_platform_role_approval_one_pending
    ON identity.platform_role_approval (
      target_player_id,
      role,
      scope_type,
      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE state = 'pending'::identity.role_approval_state;

ALTER TABLE identity.platform_role_assignment
  ADD COLUMN assignment_key text
    GENERATED ALWAYS AS (
      public.hc_role_assignment_key(player_id, role, scope_type, scope_id)
    ) STORED,
  ADD COLUMN valid_during tstzrange
    GENERATED ALWAYS AS (
      tstzrange(valid_from, COALESCE(valid_until, 'infinity'::timestamptz), '[)')
    ) STORED;

ALTER TABLE identity.platform_role_assignment
  ADD CONSTRAINT ex_platform_role_assignment_no_overlap
  EXCLUDE USING gist (
    assignment_key WITH =,
    valid_during WITH &&
  )
  WHERE (revoked_at IS NULL);

CREATE OR REPLACE FUNCTION public.hc_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.hc_touch_versioned_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target record;
  trigger_name text;
BEGIN
  FOR target IN
    SELECT c.table_schema, c.table_name,
           bool_or(c.column_name = 'row_version') AS has_row_version
      FROM information_schema.columns c
     WHERE c.table_schema IN (
       'identity', 'social', 'game', 'content', 'commerce', 'tournament', 'hive_projection'
     )
       AND c.column_name IN ('updated_at', 'row_version')
     GROUP BY c.table_schema, c.table_name
    HAVING bool_or(c.column_name = 'updated_at')
  LOOP
    trigger_name := left(format('trg_%s_touch', target.table_name), 63);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
      trigger_name,
      target.table_schema,
      target.table_name,
      CASE WHEN target.has_row_version
        THEN 'hc_touch_versioned_record'
        ELSE 'hc_touch_updated_at'
      END
    );
  END LOOP;
END;
$$;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
