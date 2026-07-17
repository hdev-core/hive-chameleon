-- migrate:up

-- SQL dump generated using DBML (dbml.dbdiagram.io)
-- Database: PostgreSQL
-- Source: docs/technical-specification/data-model/hive-chameleon.dbml

CREATE SCHEMA "identity";

CREATE SCHEMA "social";

CREATE SCHEMA "game";

CREATE SCHEMA "content";

CREATE SCHEMA "commerce";

CREATE SCHEMA "tournament";

CREATE SCHEMA "hive_projection";

CREATE TYPE "identity"."client_platform" AS ENUM (
  'webgl',
  'windows',
  'macos',
  'linux'
);

CREATE TYPE "identity"."signing_provider" AS ENUM (
  'keychain',
  'hiveauth',
  'hivesigner',
  'custodial_service',
  'other_external'
);

CREATE TYPE "identity"."external_identity_provider" AS ENUM (
  'google'
);

CREATE TYPE "identity"."external_identity_status" AS ENUM (
  'provisioning',
  'linked',
  'disabled'
);

CREATE TYPE "identity"."authentication_method" AS ENUM (
  'direct_hive_challenge',
  'google_oidc'
);

CREATE TYPE "identity"."hive_control_state" AS ENUM (
  'external_self_custodial',
  'platform_custodial',
  'authority_claimed_recovery_pending',
  'self_custody_complete'
);

CREATE TYPE "identity"."provisioning_state" AS ENUM (
  'username_confirmed',
  'keys_ready',
  'account_creation_pending',
  'account_created',
  'rc_delegation_pending',
  'rc_delegated',
  'ready',
  'retryable_failed',
  'terminal_failed'
);

CREATE TYPE "identity"."hive_key_role" AS ENUM (
  'owner',
  'active',
  'posting',
  'memo'
);

CREATE TYPE "identity"."custody_key_state" AS ENUM (
  'generated',
  'active',
  'destruction_requested',
  'destroyed',
  'abandoned'
);

CREATE TYPE "identity"."claim_state" AS ENUM (
  'requested',
  'authority_rotation_pending',
  'custody_destruction_pending',
  'recovery_change_pending',
  'self_custody_complete',
  'retryable_failed',
  'terminal_failed'
);

CREATE TYPE "identity"."disclosure_ack_source" AS ENUM (
  'google_pre_provisioning',
  'direct_hive_pre_participation'
);

CREATE TYPE "identity"."colorblind_mode" AS ENUM (
  'none',
  'protanopia',
  'deuteranopia',
  'tritanopia'
);

CREATE TYPE "identity"."character_form" AS ENUM (
  'humanoid',
  'cube'
);

CREATE TYPE "identity"."character_size_preset" AS ENUM (
  'x1_0',
  'x1_4',
  'x1_7'
);

CREATE TYPE "identity"."platform_role" AS ENUM (
  'content_reviewer',
  'content_moderator',
  'tournament_operator',
  'support_operator',
  'security_auditor',
  'platform_administrator'
);

CREATE TYPE "identity"."role_scope_type" AS ENUM (
  'platform',
  'map',
  'tournament'
);

CREATE TYPE "identity"."role_approval_state" AS ENUM (
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled'
);

CREATE TYPE "identity"."authorization_actor_type" AS ENUM (
  'player',
  'service'
);

CREATE TYPE "identity"."authorization_decision" AS ENUM (
  'allow',
  'deny',
  'grant',
  'revoke'
);

CREATE TYPE "social"."friend_request_status" AS ENUM (
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired'
);

CREATE TYPE "social"."invitation_status" AS ENUM (
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired'
);

CREATE TYPE "game"."lobby_visibility" AS ENUM (
  'public',
  'private'
);

CREATE TYPE "game"."lobby_join_source" AS ENUM (
  'server_browser',
  'quick_play',
  'friend_join',
  'invitation',
  'access_code',
  'reconnect'
);

CREATE TYPE "game"."host_assignment_reason" AS ENUM (
  'creator',
  'manual_transfer',
  'host_left',
  'host_disconnected',
  'afk'
);

CREATE TYPE "game"."game_mode" AS ENUM (
  'casual',
  'infection'
);

CREATE TYPE "game"."player_role" AS ENUM (
  'hider',
  'hunter'
);

CREATE TYPE "game"."round_status" AS ENUM (
  'preparing',
  'hiding',
  'hunting',
  'answer_check',
  'completed',
  'aborted'
);

CREATE TYPE "game"."winning_side" AS ENUM (
  'hiders',
  'hunters',
  'none'
);

CREATE TYPE "game"."participant_outcome" AS ENUM (
  'hunter_win',
  'hunter_loss',
  'hider_survived',
  'hider_found',
  'hider_converted',
  'no_contest'
);

CREATE TYPE "game"."achievement_status" AS ENUM (
  'in_progress',
  'earned'
);

CREATE TYPE "game"."round_result_revision_type" AS ENUM (
  'initial',
  'correction',
  'invalidation'
);

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

CREATE TYPE "content"."map_origin" AS ENUM (
  'official',
  'community'
);

CREATE TYPE "content"."map_lifecycle" AS ENUM (
  'draft',
  'published',
  'suspended',
  'removed'
);

CREATE TYPE "content"."map_version_status" AS ENUM (
  'draft',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
  'rejected',
  'published',
  'suspended'
);

CREATE TYPE "content"."map_asset_kind" AS ENUM (
  'package',
  'thumbnail',
  'screenshot',
  'showcase_media'
);

CREATE TYPE "content"."map_review_decision" AS ENUM (
  'under_review',
  'changes_requested',
  'approved',
  'rejected',
  'suspended'
);

CREATE TYPE "content"."distribution_platform" AS ENUM (
  'desktop',
  'web'
);

CREATE TYPE "content"."distribution_state" AS ENUM (
  'unavailable',
  'available',
  'withdrawn'
);

CREATE TYPE "content"."showcase_state" AS ENUM (
  'draft',
  'awaiting_signature',
  'broadcast',
  'published',
  'failed',
  'removed'
);

CREATE TYPE "commerce"."collectible_kind" AS ENUM (
  'badge',
  'weapon_skin',
  'character_material',
  'lobby_emote',
  'profile_frame',
  'victory_effect'
);

CREATE TYPE "commerce"."collectible_availability" AS ENUM (
  'draft',
  'active',
  'retired'
);

CREATE TYPE "commerce"."collectible_state" AS ENUM (
  'pending',
  'finalized',
  'revoked'
);

CREATE TYPE "commerce"."asset_platform" AS ENUM (
  'all',
  'desktop',
  'web'
);

CREATE TYPE "commerce"."equipment_slot" AS ENUM (
  'weapon',
  'character_material',
  'lobby_emote',
  'profile_frame',
  'victory_effect'
);

CREATE TYPE "commerce"."offer_state" AS ENUM (
  'draft',
  'scheduled',
  'active',
  'paused',
  'ended',
  'archived'
);

CREATE TYPE "commerce"."payment_direction" AS ENUM (
  'incoming',
  'outgoing'
);

CREATE TYPE "commerce"."payment_purpose" AS ENUM (
  'cosmetic_purchase',
  'tournament_entry',
  'tournament_payout'
);

CREATE TYPE "commerce"."payment_rail" AS ENUM (
  'hive',
  'hive_engine',
  'external'
);

CREATE TYPE "commerce"."payment_state" AS ENUM (
  'requested',
  'awaiting_signature',
  'broadcast',
  'included',
  'irreversible',
  'rejected',
  'expired',
  'failed'
);

CREATE TYPE "commerce"."purchase_status" AS ENUM (
  'created',
  'awaiting_payment',
  'paid',
  'fulfilling',
  'fulfilled',
  'failed'
);

CREATE TYPE "tournament"."organizer_type" AS ENUM (
  'official',
  'community'
);

CREATE TYPE "tournament"."tournament_format" AS ENUM (
  'single_match',
  'multi_round',
  'bracket',
  'organizer_defined'
);

CREATE TYPE "tournament"."tournament_status" AS ENUM (
  'draft',
  'registration_open',
  'registration_closed',
  'in_progress',
  'completed',
  'cancelled'
);

CREATE TYPE "tournament"."entry_status" AS ENUM (
  'pending_payment',
  'registered',
  'checked_in',
  'active',
  'forfeited',
  'disqualified',
  'completed',
  'cancelled'
);

CREATE TYPE "tournament"."prize_rule_type" AS ENUM (
  'percentage',
  'fixed'
);

CREATE TYPE "tournament"."match_status" AS ENUM (
  'scheduled',
  'in_progress',
  'completed',
  'aborted',
  'cancelled'
);

CREATE TYPE "tournament"."match_outcome" AS ENUM (
  'winner',
  'loser',
  'tied',
  'forfeited',
  'disqualified'
);

CREATE TYPE "tournament"."payout_status" AS ENUM (
  'pending',
  'processing',
  'paid',
  'failed'
);

CREATE TYPE "hive_projection"."authority_type" AS ENUM (
  'owner',
  'posting',
  'active'
);

CREATE TYPE "hive_projection"."operation_state" AS ENUM (
  'included',
  'irreversible',
  'reverted'
);

CREATE TYPE "hive_projection"."collectible_event_type" AS ENUM (
  'issued',
  'revoked'
);

CREATE TYPE "hive_projection"."validation_state" AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'reverted'
);

CREATE TYPE "hive_projection"."hive_engine_execution_state" AS ENUM (
  'not_applicable',
  'pending',
  'success',
  'failed'
);

CREATE TYPE "hive_projection"."transaction_state" AS ENUM (
  'requested',
  'awaiting_signature',
  'broadcast',
  'included',
  'irreversible',
  'rejected',
  'expired',
  'failed'
);

CREATE TYPE "hive_projection"."authorization_mode" AS ENUM (
  'external_wallet',
  'custodial_player',
  'official_service'
);

CREATE TYPE "hive_projection"."service_account_role" AS ENUM (
  'match_publisher',
  'collectible_issuer',
  'treasury',
  'rc_support'
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

CREATE TYPE "hive_projection"."reconciliation_state" AS ENUM (
  'pending',
  'matched',
  'divergent',
  'local_result_unavailable'
);

CREATE TYPE "hive_projection"."rc_delegation_purpose" AS ENUM (
  'initial_provisioning',
  'general_support'
);

CREATE TYPE "hive_projection"."rc_delegator_kind" AS ENUM (
  'approved_signup_sponsor',
  'platform_rc_support'
);

CREATE TYPE "hive_projection"."rc_delegation_status" AS ENUM (
  'pending',
  'active',
  'reclaiming',
  'reclaimed',
  'failed'
);

CREATE TYPE "hive_projection"."sync_health" AS ENUM (
  'healthy',
  'degraded',
  'failed'
);

CREATE TABLE "identity"."player" (
  "id" uuid PRIMARY KEY NOT NULL,
  "hive_username" varchar(16) UNIQUE NOT NULL,
  "hive_control_state" identity.hive_control_state NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_player_hive_username_lower" CHECK (hive_username = lower(hive_username))
);

CREATE TABLE "identity"."external_identity" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provider" identity.external_identity_provider NOT NULL,
  "verified_issuer" varchar(255) NOT NULL,
  "subject_lookup_hash" char(64) NOT NULL,
  "player_id" uuid UNIQUE,
  "status" identity.external_identity_status NOT NULL DEFAULT 'provisioning',
  "verified_at" timestamptz NOT NULL,
  "linked_at" timestamptz,
  "last_authenticated_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_external_identity_auth_time" CHECK (last_authenticated_at >= verified_at),
  CONSTRAINT "chk_external_identity_linked" CHECK ((status <> 'linked') OR (player_id IS NOT NULL AND linked_at IS NOT NULL))
);

CREATE TABLE "identity"."hive_account_provisioning" (
  "id" uuid PRIMARY KEY NOT NULL,
  "external_identity_id" uuid UNIQUE NOT NULL,
  "resulting_player_id" uuid UNIQUE,
  "idempotency_key" varchar(128) UNIQUE NOT NULL,
  "requested_hive_username" varchar(16) NOT NULL,
  "state" identity.provisioning_state NOT NULL DEFAULT 'username_confirmed',
  "sponsor_program" varchar(64) NOT NULL,
  "sponsor_policy_version" varchar(32) NOT NULL,
  "sponsor_hive_account" varchar(16) NOT NULL,
  "sponsor_request_reference" varchar(128),
  "account_creation_transaction_id" varchar(128),
  "account_creation_operation_id" uuid UNIQUE,
  "initial_rc_delegation_id" uuid UNIQUE,
  "username_confirmed_at" timestamptz NOT NULL,
  "keys_ready_at" timestamptz,
  "account_observed_at" timestamptz,
  "account_irreversible_at" timestamptz,
  "authorities_verified_at" timestamptz,
  "rc_verified_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamptz,
  "next_retry_at" timestamptz,
  "last_failure_code" varchar(64),
  "ready_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_provisioning_username_lower" CHECK (requested_hive_username = lower(requested_hive_username)),
  CONSTRAINT "chk_provisioning_sponsor_account_lower" CHECK (sponsor_hive_account = lower(sponsor_hive_account)),
  CONSTRAINT "chk_provisioning_attempts" CHECK (attempt_count >= 0),
  CONSTRAINT "chk_provisioning_keys_ready" CHECK ((state <> 'keys_ready') OR keys_ready_at IS NOT NULL),
  CONSTRAINT "chk_provisioning_account_created" CHECK ((state <> 'account_created') OR account_observed_at IS NOT NULL),
  CONSTRAINT "chk_provisioning_rc_delegated" CHECK ((state <> 'rc_delegated') OR initial_rc_delegation_id IS NOT NULL),
  CONSTRAINT "chk_provisioning_ready" CHECK ((state <> 'ready') OR (resulting_player_id IS NOT NULL AND keys_ready_at IS NOT NULL AND account_irreversible_at IS NOT NULL AND authorities_verified_at IS NOT NULL AND initial_rc_delegation_id IS NOT NULL AND rc_verified_at IS NOT NULL AND ready_at IS NOT NULL))
);

CREATE TABLE "identity"."custody_key_reference" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provisioning_id" uuid NOT NULL,
  "player_id" uuid,
  "authority_role" identity.hive_key_role NOT NULL,
  "hive_public_key" varchar(64) NOT NULL,
  "custody_provider_key_reference" text UNIQUE NOT NULL,
  "state" identity.custody_key_state NOT NULL DEFAULT 'generated',
  "activated_at" timestamptz,
  "destruction_requested_at" timestamptz,
  "destruction_completed_at" timestamptz,
  "destruction_evidence_reference" text,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_custody_key_active" CHECK ((state <> 'active') OR activated_at IS NOT NULL),
  CONSTRAINT "chk_custody_key_destruction_requested" CHECK ((state <> 'destruction_requested') OR destruction_requested_at IS NOT NULL),
  CONSTRAINT "chk_custody_key_destroyed" CHECK ((state <> 'destroyed') OR (destruction_requested_at IS NOT NULL AND destruction_completed_at IS NOT NULL))
);

CREATE TABLE "identity"."hive_account_claim" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "idempotency_key" varchar(128) UNIQUE NOT NULL,
  "state" identity.claim_state NOT NULL DEFAULT 'requested',
  "target_owner_authority_canonical" text NOT NULL,
  "target_active_authority_canonical" text NOT NULL,
  "target_posting_authority_canonical" text NOT NULL,
  "target_memo_public_key" varchar(64) NOT NULL,
  "prior_recovery_hive_account" varchar(16) NOT NULL,
  "selected_recovery_hive_account" varchar(16) NOT NULL,
  "transaction_intent_id" uuid UNIQUE,
  "change_recovery_operation_id" uuid UNIQUE,
  "account_update_operation_id" uuid UNIQUE,
  "changed_recovery_virtual_operation_id" uuid UNIQUE,
  "authority_rotation_included_at" timestamptz,
  "authority_rotation_irreversible_at" timestamptz,
  "recovery_request_verified_at" timestamptz,
  "custodial_signing_disabled_at" timestamptz,
  "key_destruction_completed_at" timestamptz,
  "recovery_effective_expected_at" timestamptz,
  "recovery_effective_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamptz,
  "next_retry_at" timestamptz,
  "last_failure_code" varchar(64),
  "requested_at" timestamptz NOT NULL DEFAULT (now()),
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_claim_prior_recovery_lower" CHECK (prior_recovery_hive_account = lower(prior_recovery_hive_account)),
  CONSTRAINT "chk_claim_target_recovery_lower" CHECK (selected_recovery_hive_account = lower(selected_recovery_hive_account)),
  CONSTRAINT "chk_claim_nonplatform_recovery" CHECK (prior_recovery_hive_account <> selected_recovery_hive_account),
  CONSTRAINT "chk_claim_attempts" CHECK (attempt_count >= 0),
  CONSTRAINT "chk_claim_recovery_expected" CHECK (recovery_effective_expected_at IS NULL OR recovery_effective_expected_at >= requested_at),
  CONSTRAINT "chk_claim_recovery_pending" CHECK ((state <> 'recovery_change_pending') OR (authority_rotation_irreversible_at IS NOT NULL AND recovery_request_verified_at IS NOT NULL AND custodial_signing_disabled_at IS NOT NULL AND key_destruction_completed_at IS NOT NULL)),
  CONSTRAINT "chk_claim_complete" CHECK ((state <> 'self_custody_complete') OR (authority_rotation_irreversible_at IS NOT NULL AND custodial_signing_disabled_at IS NOT NULL AND key_destruction_completed_at IS NOT NULL AND recovery_effective_at IS NOT NULL AND changed_recovery_virtual_operation_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE "identity"."public_record_disclosure" (
  "disclosure_version" varchar(32) PRIMARY KEY NOT NULL,
  "content_sha256" char(64) NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "retired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_public_disclosure_retired" CHECK (retired_at IS NULL OR retired_at > effective_at)
);

CREATE TABLE "identity"."public_record_disclosure_acknowledgment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "disclosure_version" varchar(32) NOT NULL,
  "external_identity_id" uuid,
  "player_id" uuid,
  "source" identity.disclosure_ack_source NOT NULL,
  "acknowledged_at" timestamptz NOT NULL,
  "player_linked_at" timestamptz,
  CONSTRAINT "chk_disclosure_ack_subject" CHECK (external_identity_id IS NOT NULL OR player_id IS NOT NULL),
  CONSTRAINT "chk_disclosure_ack_player_link" CHECK (player_linked_at IS NULL OR player_id IS NOT NULL),
  CONSTRAINT "chk_disclosure_ack_google_subject" CHECK ((source <> 'google_pre_provisioning') OR external_identity_id IS NOT NULL),
  CONSTRAINT "chk_disclosure_ack_hive_subject" CHECK ((source <> 'direct_hive_pre_participation') OR player_id IS NOT NULL)
);

CREATE TABLE "identity"."player_profile" (
  "player_id" uuid PRIMARY KEY NOT NULL,
  "hive_display_name" varchar(128),
  "avatar_url" text,
  "hive_profile_metadata" jsonb NOT NULL DEFAULT '{}',
  "hive_synced_at" timestamptz,
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1
);

CREATE TABLE "identity"."auth_session" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "external_identity_id" uuid,
  "refresh_token_hash" char(64) UNIQUE NOT NULL,
  "platform" identity.client_platform NOT NULL,
  "authentication_method" identity.authentication_method NOT NULL,
  "hive_signing_provider" identity.signing_provider,
  "hive_control_state_at_issue" identity.hive_control_state NOT NULL,
  "custodial_signing_eligible" boolean NOT NULL DEFAULT false,
  "issued_at" timestamptz NOT NULL DEFAULT (now()),
  "last_used_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revocation_reason" varchar(64),
  CONSTRAINT "chk_auth_session_expiry" CHECK (expires_at > issued_at),
  CONSTRAINT "chk_auth_session_revoked_time" CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CONSTRAINT "chk_auth_session_google_identity" CHECK ((authentication_method <> 'google_oidc') OR external_identity_id IS NOT NULL),
  CONSTRAINT "chk_auth_session_custodial_signer" CHECK ((custodial_signing_eligible AND hive_signing_provider = 'custodial_service' AND hive_control_state_at_issue = 'platform_custodial') OR (NOT custodial_signing_eligible AND (hive_signing_provider IS NULL OR hive_signing_provider <> 'custodial_service')))
);

CREATE TABLE "identity"."player_preference" (
  "player_id" uuid PRIMARY KEY NOT NULL,
  "streamer_mode" boolean NOT NULL DEFAULT false,
  "ui_scale" numeric(4,2) NOT NULL DEFAULT 1,
  "colorblind_mode" identity.colorblind_mode NOT NULL DEFAULT 'none',
  "crosshair_config" jsonb NOT NULL DEFAULT '{}',
  "master_volume" numeric(4,3) NOT NULL DEFAULT 1,
  "effects_volume" numeric(4,3) NOT NULL DEFAULT 1,
  "interface_volume" numeric(4,3) NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_player_preference_ui_scale" CHECK (ui_scale BETWEEN 0.50 AND 2.00),
  CONSTRAINT "chk_player_preference_master_volume" CHECK (master_volume BETWEEN 0 AND 1),
  CONSTRAINT "chk_player_preference_effects_volume" CHECK (effects_volume BETWEEN 0 AND 1),
  CONSTRAINT "chk_player_preference_interface_volume" CHECK (interface_volume BETWEEN 0 AND 1)
);

CREATE TABLE "identity"."player_platform_setting" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "platform" identity.client_platform NOT NULL,
  "mouse_sensitivity" numeric(8,4),
  "controller_sensitivity" numeric(8,4),
  "control_mapping" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_platform_mouse_sensitivity" CHECK (mouse_sensitivity IS NULL OR mouse_sensitivity > 0),
  CONSTRAINT "chk_platform_controller_sensitivity" CHECK (controller_sensitivity IS NULL OR controller_sensitivity > 0)
);

CREATE TABLE "identity"."player_appearance" (
  "player_id" uuid PRIMARY KEY NOT NULL,
  "character_form" identity.character_form NOT NULL DEFAULT 'humanoid',
  "size_preset" identity.character_size_preset NOT NULL DEFAULT 'x1_0',
  "lobby_pose_code" varchar(64) NOT NULL DEFAULT 'neutral',
  "paint_object_key" text,
  "paint_sha256" char(64),
  "appearance_format_version" smallint NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_appearance_cube_size" CHECK (character_form <> 'cube' OR size_preset = 'x1_0'),
  CONSTRAINT "chk_appearance_paint_pair" CHECK ((paint_object_key IS NULL) = (paint_sha256 IS NULL)),
  CONSTRAINT "chk_appearance_format_version" CHECK (appearance_format_version > 0)
);

CREATE TABLE "identity"."platform_role_approval" (
  "id" uuid PRIMARY KEY NOT NULL,
  "target_player_id" uuid NOT NULL,
  "role" identity.platform_role NOT NULL,
  "scope_type" identity.role_scope_type NOT NULL DEFAULT 'platform',
  "scope_id" uuid,
  "valid_from" timestamptz NOT NULL,
  "valid_until" timestamptz,
  "requested_by_player_id" uuid NOT NULL,
  "approved_by_player_id" uuid,
  "state" identity.role_approval_state NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT (now()),
  "expires_at" timestamptz NOT NULL,
  "decided_at" timestamptz,
  CONSTRAINT "chk_platform_role_approval_scope" CHECK ((scope_type = 'platform' AND scope_id IS NULL) OR (scope_type <> 'platform' AND scope_id IS NOT NULL)),
  CONSTRAINT "chk_platform_role_approval_validity" CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT "chk_platform_role_approval_expiry" CHECK (expires_at > requested_at),
  CONSTRAINT "chk_platform_role_approval_separation" CHECK (approved_by_player_id IS NULL OR approved_by_player_id <> requested_by_player_id),
  CONSTRAINT "chk_platform_role_approval_approved" CHECK ((state <> 'approved') OR (approved_by_player_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT "chk_platform_role_approval_decided" CHECK ((state NOT IN ('rejected', 'cancelled')) OR decided_at IS NOT NULL)
);

CREATE TABLE "identity"."platform_role_assignment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "role" identity.platform_role NOT NULL,
  "scope_type" identity.role_scope_type NOT NULL DEFAULT 'platform',
  "scope_id" uuid,
  "valid_from" timestamptz NOT NULL DEFAULT (now()),
  "valid_until" timestamptz,
  "granted_by_player_id" uuid NOT NULL,
  "approval_id" uuid UNIQUE,
  "grant_audit_event_id" uuid UNIQUE NOT NULL,
  "reason" text NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_player_id" uuid,
  "revocation_reason" text,
  "revocation_audit_event_id" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_platform_role_assignment_scope" CHECK ((scope_type = 'platform' AND scope_id IS NULL) OR (scope_type <> 'platform' AND scope_id IS NOT NULL)),
  CONSTRAINT "chk_platform_role_assignment_validity" CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT "chk_platform_role_assignment_no_self_grant" CHECK (player_id <> granted_by_player_id),
  CONSTRAINT "chk_platform_role_assignment_revocation_time" CHECK (revoked_at IS NULL OR revoked_at >= valid_from),
  CONSTRAINT "chk_platform_role_assignment_revocation" CHECK ((revoked_at IS NULL AND revoked_by_player_id IS NULL AND revocation_reason IS NULL AND revocation_audit_event_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_player_id IS NOT NULL AND revocation_reason IS NOT NULL AND revocation_audit_event_id IS NOT NULL))
);

CREATE TABLE "identity"."authorization_audit_event" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_type" identity.authorization_actor_type NOT NULL,
  "actor_player_id" uuid,
  "actor_service_name" varchar(128),
  "decision" identity.authorization_decision NOT NULL,
  "action" varchar(128) NOT NULL,
  "resource_type" varchar(128),
  "resource_id" uuid,
  "subject_player_id" uuid,
  "role" identity.platform_role,
  "scope_type" identity.role_scope_type,
  "scope_id" uuid,
  "correlation_id" uuid NOT NULL,
  "reason_code" varchar(128) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "occurred_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_authorization_audit_actor" CHECK ((actor_type = 'player' AND actor_player_id IS NOT NULL AND actor_service_name IS NULL) OR (actor_type = 'service' AND actor_player_id IS NULL AND actor_service_name IS NOT NULL)),
  CONSTRAINT "chk_authorization_audit_scope" CHECK ((scope_type IS NULL AND scope_id IS NULL) OR (scope_type = 'platform' AND scope_id IS NULL) OR (scope_type IN ('map', 'tournament') AND scope_id IS NOT NULL))
);

CREATE TABLE "social"."friend_request" (
  "id" uuid PRIMARY KEY NOT NULL,
  "requester_player_id" uuid NOT NULL,
  "recipient_player_id" uuid NOT NULL,
  "status" social.friend_request_status NOT NULL DEFAULT 'pending',
  "sent_at" timestamptz NOT NULL DEFAULT (now()),
  "responded_at" timestamptz,
  "expires_at" timestamptz,
  CONSTRAINT "chk_friend_request_not_self" CHECK (requester_player_id <> recipient_player_id),
  CONSTRAINT "chk_friend_request_response_time" CHECK (responded_at IS NULL OR responded_at >= sent_at),
  CONSTRAINT "chk_friend_request_expiry" CHECK (expires_at IS NULL OR expires_at > sent_at)
);

CREATE TABLE "social"."friendship" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_low_id" uuid NOT NULL,
  "player_high_id" uuid NOT NULL,
  "source_request_id" uuid UNIQUE,
  "accepted_at" timestamptz NOT NULL,
  CONSTRAINT "chk_friendship_canonical_pair" CHECK (player_low_id < player_high_id)
);

CREATE TABLE "social"."player_block" (
  "blocker_player_id" uuid NOT NULL,
  "blocked_player_id" uuid NOT NULL,
  "blocked_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_player_block_not_self" CHECK (blocker_player_id <> blocked_player_id),
  PRIMARY KEY ("blocker_player_id", "blocked_player_id")
);

CREATE TABLE "social"."lobby_invitation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lobby_id" uuid NOT NULL,
  "inviter_player_id" uuid NOT NULL,
  "invitee_player_id" uuid NOT NULL,
  "status" social.invitation_status NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "expires_at" timestamptz NOT NULL,
  "responded_at" timestamptz,
  CONSTRAINT "chk_lobby_invitation_not_self" CHECK (inviter_player_id <> invitee_player_id),
  CONSTRAINT "chk_lobby_invitation_expiry" CHECK (expires_at > created_at),
  CONSTRAINT "chk_lobby_invitation_response_time" CHECK (responded_at IS NULL OR responded_at >= created_at)
);

CREATE TABLE "social"."notification" (
  "id" uuid PRIMARY KEY NOT NULL,
  "recipient_player_id" uuid NOT NULL,
  "notification_type" varchar(64) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "related_entity_type" varchar(64),
  "related_entity_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "read_at" timestamptz,
  "expires_at" timestamptz,
  CONSTRAINT "chk_notification_read_time" CHECK (read_at IS NULL OR read_at >= created_at),
  CONSTRAINT "chk_notification_expiry" CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE "game"."lobby" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" varchar(128) NOT NULL,
  "current_host_player_id" uuid NOT NULL,
  "visibility" game.lobby_visibility NOT NULL DEFAULT 'public',
  "password_hash" text,
  "max_players" smallint NOT NULL DEFAULT 10,
  "region_code" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "closed_at" timestamptz,
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_lobby_max_players" CHECK (max_players BETWEEN 2 AND 10),
  CONSTRAINT "chk_lobby_password_policy" CHECK ((visibility = 'public' AND password_hash IS NULL) OR (visibility = 'private' AND password_hash IS NOT NULL)),
  CONSTRAINT "chk_lobby_closed_time" CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE TABLE "game"."lobby_access_token" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lobby_id" uuid NOT NULL,
  "created_by_player_id" uuid NOT NULL,
  "token_hash" char(64) UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "chk_lobby_access_token_expiry" CHECK (expires_at > created_at),
  CONSTRAINT "chk_lobby_access_token_revoked" CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE "game"."lobby_membership" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lobby_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "join_source" game.lobby_join_source NOT NULL,
  "initially_spectator" boolean NOT NULL DEFAULT false,
  "joined_at" timestamptz NOT NULL DEFAULT (now()),
  "left_at" timestamptz,
  CONSTRAINT "chk_lobby_membership_left_time" CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE TABLE "game"."lobby_host_assignment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lobby_id" uuid NOT NULL,
  "host_player_id" uuid NOT NULL,
  "reason" game.host_assignment_reason NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT (now()),
  "ended_at" timestamptz,
  CONSTRAINT "chk_lobby_host_assignment_time" CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE "game"."lobby_configuration" (
  "lobby_id" uuid PRIMARY KEY NOT NULL,
  "mode" game.game_mode NOT NULL DEFAULT 'casual',
  "map_version_id" uuid,
  "hunter_count" smallint NOT NULL DEFAULT 1,
  "hiding_duration_seconds" integer NOT NULL,
  "hunting_duration_seconds" integer NOT NULL,
  "taunt_enabled" boolean NOT NULL DEFAULT true,
  "taunt_interval_seconds" integer,
  "shell_limit" integer NOT NULL,
  "reload_duration_ms" integer NOT NULL,
  "auto_start_enabled" boolean NOT NULL DEFAULT true,
  "auto_start_threshold" smallint NOT NULL DEFAULT 7,
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_lobby_configuration_hunters" CHECK (hunter_count BETWEEN 1 AND 2),
  CONSTRAINT "chk_lobby_configuration_hiding_time" CHECK (hiding_duration_seconds > 0),
  CONSTRAINT "chk_lobby_configuration_hunting_time" CHECK (hunting_duration_seconds > 0),
  CONSTRAINT "chk_lobby_configuration_shell_limit" CHECK (shell_limit > 0),
  CONSTRAINT "chk_lobby_configuration_reload" CHECK (reload_duration_ms > 0),
  CONSTRAINT "chk_lobby_configuration_auto_start" CHECK (auto_start_threshold BETWEEN 2 AND 10),
  CONSTRAINT "chk_lobby_configuration_taunt" CHECK ((NOT taunt_enabled) OR (taunt_interval_seconds IS NOT NULL AND taunt_interval_seconds > 0))
);

CREATE TABLE "game"."game_round" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lobby_id" uuid NOT NULL,
  "sequence_number" integer NOT NULL,
  "mode" game.game_mode NOT NULL,
  "map_version_id" uuid NOT NULL,
  "hunter_count" smallint NOT NULL,
  "hiding_duration_seconds" integer NOT NULL,
  "hunting_duration_seconds" integer NOT NULL,
  "taunt_enabled" boolean NOT NULL,
  "taunt_interval_seconds" integer,
  "shell_limit" integer NOT NULL,
  "reload_duration_ms" integer NOT NULL,
  "auto_start_enabled" boolean NOT NULL,
  "auto_start_threshold" smallint NOT NULL,
  "rule_schema_version" smallint NOT NULL DEFAULT 1,
  "additional_rule_snapshot" jsonb NOT NULL DEFAULT '{}',
  "game_server_build_version" varchar(64) NOT NULL,
  "protocol_version" varchar(32) NOT NULL,
  "status" game.round_status NOT NULL,
  "winning_side" game.winning_side,
  "result_schema_version" varchar(32) NOT NULL,
  "scoring_rule_version" varchar(32) NOT NULL,
  "canonical_result_sha256" char(64),
  "started_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "abort_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_game_round_sequence" CHECK (sequence_number > 0),
  CONSTRAINT "chk_game_round_hunters" CHECK (hunter_count BETWEEN 1 AND 2),
  CONSTRAINT "chk_game_round_times" CHECK (hiding_duration_seconds > 0 AND hunting_duration_seconds > 0),
  CONSTRAINT "chk_game_round_taunt" CHECK ((NOT taunt_enabled) OR (taunt_interval_seconds IS NOT NULL AND taunt_interval_seconds > 0)),
  CONSTRAINT "chk_game_round_weapon_rules" CHECK (shell_limit > 0 AND reload_duration_ms > 0),
  CONSTRAINT "chk_game_round_rule_version" CHECK (rule_schema_version > 0),
  CONSTRAINT "chk_game_round_aborted" CHECK ((status <> 'aborted') OR (ended_at IS NOT NULL AND abort_reason IS NOT NULL AND winning_side IS NULL)),
  CONSTRAINT "chk_game_round_completed" CHECK ((status <> 'completed') OR (ended_at IS NOT NULL AND winning_side IS NOT NULL AND canonical_result_sha256 IS NOT NULL))
);

CREATE TABLE "game"."round_participant" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "hunter_volunteer" boolean NOT NULL DEFAULT false,
  "initial_role" game.player_role NOT NULL,
  "final_role" game.player_role NOT NULL,
  "character_form" identity.character_form NOT NULL,
  "size_preset" identity.character_size_preset NOT NULL,
  "outcome" game.participant_outcome NOT NULL,
  "survival_duration_ms" bigint,
  "final_score" numeric(18,4),
  "score_breakdown" jsonb NOT NULL DEFAULT '{}',
  "found_or_converted_at" timestamptz,
  "reconnected" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_round_participant_cube_size" CHECK (character_form <> 'cube' OR size_preset = 'x1_0'),
  CONSTRAINT "chk_round_participant_survival" CHECK (survival_duration_ms IS NULL OR survival_duration_ms >= 0)
);

CREATE TABLE "game"."round_discovery" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_id" uuid NOT NULL,
  "hunter_player_id" uuid NOT NULL,
  "hider_player_id" uuid NOT NULL,
  "discovery_sequence" smallint NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "caused_infection_conversion" boolean NOT NULL DEFAULT false,
  CONSTRAINT "chk_round_discovery_distinct_players" CHECK (hunter_player_id <> hider_player_id),
  CONSTRAINT "chk_round_discovery_sequence" CHECK (discovery_sequence > 0)
);

CREATE TABLE "game"."round_disguise_snapshot" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_participant_id" uuid UNIQUE NOT NULL,
  "object_storage_key" text NOT NULL,
  "sha256" char(64) NOT NULL,
  "format_version" smallint NOT NULL DEFAULT 1,
  "captured_at" timestamptz NOT NULL,
  CONSTRAINT "chk_round_disguise_format" CHECK (format_version > 0)
);

CREATE TABLE "game"."round_like" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_id" uuid NOT NULL,
  "voter_player_id" uuid NOT NULL,
  "target_hider_player_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_round_like_not_self" CHECK (voter_player_id <> target_hider_player_id)
);

CREATE TABLE "game"."round_result_revision" (
  "id" uuid PRIMARY KEY NOT NULL,
  "round_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "revision_type" game.round_result_revision_type NOT NULL,
  "previous_revision_id" uuid UNIQUE,
  "result_schema_version" varchar(32) NOT NULL,
  "scoring_rule_version" varchar(32) NOT NULL,
  "canonical_complete_result_sha256" char(64),
  "canonical_result_object_key" text,
  "reason_code" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_round_result_revision_number" CHECK (revision_number > 0),
  CONSTRAINT "chk_round_result_revision_initial" CHECK ((revision_type <> 'initial') OR (revision_number = 1 AND previous_revision_id IS NULL AND reason_code IS NULL AND canonical_complete_result_sha256 IS NOT NULL AND canonical_result_object_key IS NOT NULL)),
  CONSTRAINT "chk_round_result_revision_correction" CHECK ((revision_type <> 'correction') OR (previous_revision_id IS NOT NULL AND reason_code IS NOT NULL AND canonical_complete_result_sha256 IS NOT NULL AND canonical_result_object_key IS NOT NULL)),
  CONSTRAINT "chk_round_result_revision_invalidation" CHECK ((revision_type <> 'invalidation') OR (previous_revision_id IS NOT NULL AND reason_code IS NOT NULL AND canonical_complete_result_sha256 IS NULL AND canonical_result_object_key IS NULL))
);

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

CREATE TABLE "game"."player_mode_stat" (
  "player_id" uuid NOT NULL,
  "mode" game.game_mode NOT NULL,
  "rounds_played" bigint NOT NULL DEFAULT 0,
  "hunter_wins" bigint NOT NULL DEFAULT 0,
  "hider_wins" bigint NOT NULL DEFAULT 0,
  "discoveries" bigint NOT NULL DEFAULT 0,
  "times_survived" bigint NOT NULL DEFAULT 0,
  "infection_conversions" bigint NOT NULL DEFAULT 0,
  "likes_given" bigint NOT NULL DEFAULT 0,
  "likes_received" bigint NOT NULL DEFAULT 0,
  "aggregate_score" numeric(24,4) NOT NULL DEFAULT 0,
  "last_recalculated_at" timestamptz NOT NULL,
  CONSTRAINT "chk_player_mode_stat_rounds" CHECK (rounds_played >= 0 AND hunter_wins >= 0 AND hider_wins >= 0),
  CONSTRAINT "chk_player_mode_stat_performance" CHECK (discoveries >= 0 AND times_survived >= 0 AND infection_conversions >= 0),
  CONSTRAINT "chk_player_mode_stat_likes" CHECK (likes_given >= 0 AND likes_received >= 0),
  PRIMARY KEY ("player_id", "mode")
);

CREATE TABLE "game"."achievement_definition" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" varchar(128) UNIQUE NOT NULL,
  "display_name" varchar(128) NOT NULL,
  "description" text NOT NULL,
  "criteria_version" smallint NOT NULL DEFAULT 1,
  "criteria" jsonb NOT NULL DEFAULT '{}',
  "badge_collectible_definition_id" uuid,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_achievement_criteria_version" CHECK (criteria_version > 0)
);

CREATE TABLE "game"."player_achievement" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "achievement_definition_id" uuid NOT NULL,
  "status" game.achievement_status NOT NULL DEFAULT 'in_progress',
  "progress_value" numeric(20,4) NOT NULL DEFAULT 0,
  "progress" jsonb NOT NULL DEFAULT '{}',
  "earned_at" timestamptz,
  "award_correlation_id" uuid UNIQUE,
  "badge_collectible_instance_id" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_player_achievement_progress" CHECK (progress_value >= 0),
  CONSTRAINT "chk_player_achievement_earned" CHECK ((status <> 'earned') OR earned_at IS NOT NULL)
);

CREATE TABLE "content"."map" (
  "id" uuid PRIMARY KEY NOT NULL,
  "origin" content.map_origin NOT NULL,
  "creator_player_id" uuid,
  "slug" varchar(120) UNIQUE NOT NULL,
  "title" varchar(120) NOT NULL,
  "description" text NOT NULL,
  "lifecycle" content.map_lifecycle NOT NULL DEFAULT 'draft',
  "cached_play_count" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_map_community_creator" CHECK (origin <> 'community' OR creator_player_id IS NOT NULL),
  CONSTRAINT "chk_map_play_count" CHECK (cached_play_count >= 0),
  CONSTRAINT "chk_map_slug_lower" CHECK (slug = lower(slug))
);

CREATE TABLE "content"."map_version" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_id" uuid NOT NULL,
  "version_number" varchar(32) NOT NULL,
  "manifest" jsonb NOT NULL DEFAULT '{}',
  "status" content.map_version_status NOT NULL DEFAULT 'draft',
  "license_declaration_version" varchar(32) NOT NULL,
  "license_accepted_at" timestamptz NOT NULL,
  "technical_validation" jsonb NOT NULL DEFAULT '{}',
  "submitted_at" timestamptz,
  "approved_at" timestamptz,
  "published_at" timestamptz,
  "suspended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_map_version_license_time" CHECK (license_accepted_at >= created_at),
  CONSTRAINT "chk_map_version_submission_time" CHECK (submitted_at IS NULL OR submitted_at >= created_at),
  CONSTRAINT "chk_map_version_approval_requires_submission" CHECK (approved_at IS NULL OR submitted_at IS NOT NULL),
  CONSTRAINT "chk_map_version_publish_requires_approval" CHECK (published_at IS NULL OR approved_at IS NOT NULL)
);

CREATE TABLE "content"."map_lifecycle_event" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_id" uuid NOT NULL,
  "map_version_id" uuid,
  "previous_lifecycle" content.map_lifecycle,
  "new_lifecycle" content.map_lifecycle NOT NULL,
  "reason_code" varchar(64),
  "creator_message" text,
  "internal_notes" text,
  "changed_by_player_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_map_lifecycle_event_change" CHECK (previous_lifecycle IS NULL OR previous_lifecycle <> new_lifecycle)
);

CREATE TABLE "content"."map_asset" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_version_id" uuid NOT NULL,
  "kind" content.map_asset_kind NOT NULL,
  "object_storage_key" text UNIQUE NOT NULL,
  "media_type" varchar(128) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" char(64) NOT NULL,
  "sort_order" smallint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_map_asset_size" CHECK (size_bytes >= 0),
  CONSTRAINT "chk_map_asset_sort_order" CHECK (sort_order >= 0)
);

CREATE TABLE "content"."map_review" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_version_id" uuid NOT NULL,
  "reviewer_player_id" uuid NOT NULL,
  "decision" content.map_review_decision NOT NULL,
  "creator_feedback" text,
  "internal_notes" text,
  "reviewed_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "content"."tag" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" varchar(64) UNIQUE NOT NULL,
  "display_name" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_tag_code_lower" CHECK (code = lower(code))
);

CREATE TABLE "content"."map_tag" (
  "map_id" uuid NOT NULL,
  "tag_id" uuid NOT NULL,
  PRIMARY KEY ("map_id", "tag_id")
);

CREATE TABLE "content"."map_distribution" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_version_id" uuid NOT NULL,
  "platform" content.distribution_platform NOT NULL,
  "state" content.distribution_state NOT NULL DEFAULT 'unavailable',
  "required_game_build_version" varchar(64) NOT NULL,
  "published_at" timestamptz,
  "withdrawn_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_map_distribution_state_times" CHECK ((state = 'unavailable' AND published_at IS NULL AND withdrawn_at IS NULL) OR (state = 'available' AND published_at IS NOT NULL AND withdrawn_at IS NULL) OR (state = 'withdrawn' AND published_at IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_at >= published_at))
);

CREATE TABLE "content"."map_showcase" (
  "id" uuid PRIMARY KEY NOT NULL,
  "map_id" uuid NOT NULL,
  "map_version_id" uuid,
  "creator_player_id" uuid NOT NULL,
  "community_post_id" uuid UNIQUE,
  "state" content.showcase_state NOT NULL DEFAULT 'draft',
  "draft_title" varchar(256),
  "draft_body" text,
  "draft_metadata" jsonb NOT NULL DEFAULT '{}',
  "published_at" timestamptz,
  "last_hive_sync_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1
);

CREATE TABLE "commerce"."collectible_definition" (
  "id" uuid PRIMARY KEY NOT NULL,
  "definition_code" varchar(128) UNIQUE NOT NULL,
  "kind" commerce.collectible_kind NOT NULL,
  "display_name" varchar(128) NOT NULL,
  "description" text NOT NULL,
  "metadata_uri" text NOT NULL,
  "metadata_sha256" char(64) NOT NULL,
  "availability" commerce.collectible_availability NOT NULL DEFAULT 'draft',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "commerce"."collectible_asset" (
  "id" uuid PRIMARY KEY NOT NULL,
  "collectible_definition_id" uuid NOT NULL,
  "asset_kind" varchar(64) NOT NULL,
  "platform" commerce.asset_platform NOT NULL DEFAULT 'all',
  "object_storage_key" text UNIQUE NOT NULL,
  "media_type" varchar(128) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" char(64) NOT NULL,
  "sort_order" smallint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_collectible_asset_size" CHECK (size_bytes >= 0),
  CONSTRAINT "chk_collectible_asset_sort" CHECK (sort_order >= 0)
);

CREATE TABLE "commerce"."collectible_instance" (
  "id" uuid PRIMARY KEY NOT NULL,
  "collectible_definition_id" uuid NOT NULL,
  "owner_player_id" uuid NOT NULL,
  "issuer_hive_account" varchar(16) NOT NULL,
  "issuance_reason" varchar(64) NOT NULL,
  "metadata_uri" text NOT NULL,
  "metadata_sha256" char(64) NOT NULL,
  "state" commerce.collectible_state NOT NULL DEFAULT 'pending',
  "issued_event_id" uuid UNIQUE NOT NULL,
  "revoked_event_id" uuid UNIQUE,
  "issued_hive_transaction_id" varchar(128) NOT NULL,
  "issued_hive_block_number" bigint NOT NULL,
  "irreversible_at" timestamptz,
  "revoked_at" timestamptz,
  "payment_transaction_id" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_collectible_instance_issuer_lower" CHECK (issuer_hive_account = lower(issuer_hive_account)),
  CONSTRAINT "chk_collectible_instance_finalized" CHECK ((state <> 'finalized') OR irreversible_at IS NOT NULL),
  CONSTRAINT "chk_collectible_instance_revoked" CHECK ((state <> 'revoked') OR (revoked_at IS NOT NULL AND revoked_event_id IS NOT NULL))
);

CREATE TABLE "commerce"."player_loadout" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "equipment_slot" commerce.equipment_slot NOT NULL,
  "collectible_instance_id" uuid NOT NULL,
  "equipped_at" timestamptz NOT NULL DEFAULT (now()),
  "unequipped_at" timestamptz,
  CONSTRAINT "chk_player_loadout_unequipped" CHECK (unequipped_at IS NULL OR unequipped_at >= equipped_at)
);

CREATE TABLE "commerce"."shop_offer" (
  "id" uuid PRIMARY KEY NOT NULL,
  "collectible_definition_id" uuid NOT NULL,
  "state" commerce.offer_state NOT NULL DEFAULT 'draft',
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "purchase_limit_per_player" integer,
  "total_purchase_limit" integer,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_shop_offer_window" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT "chk_shop_offer_player_limit" CHECK (purchase_limit_per_player IS NULL OR purchase_limit_per_player > 0),
  CONSTRAINT "chk_shop_offer_total_limit" CHECK (total_purchase_limit IS NULL OR total_purchase_limit > 0)
);

CREATE TABLE "commerce"."shop_offer_price" (
  "id" uuid PRIMARY KEY NOT NULL,
  "shop_offer_id" uuid NOT NULL,
  "payment_rail" commerce.payment_rail NOT NULL,
  "asset_code" varchar(16) NOT NULL,
  "amount" numeric(20,8) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_shop_offer_price_asset_upper" CHECK (asset_code = upper(asset_code)),
  CONSTRAINT "chk_shop_offer_price_amount" CHECK (amount > 0)
);

CREATE TABLE "commerce"."payment_transaction" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "direction" commerce.payment_direction NOT NULL,
  "purpose" commerce.payment_purpose NOT NULL,
  "rail" commerce.payment_rail NOT NULL,
  "asset_code" varchar(16) NOT NULL,
  "amount" numeric(20,8) NOT NULL,
  "sender_reference" varchar(128) NOT NULL,
  "recipient_reference" varchar(128) NOT NULL,
  "external_transaction_id" varchar(128),
  "operation_index" integer,
  "correlation_reference" varchar(256),
  "transaction_intent_id" uuid UNIQUE,
  "state" commerce.payment_state NOT NULL DEFAULT 'requested',
  "requested_at" timestamptz NOT NULL DEFAULT (now()),
  "included_at" timestamptz,
  "irreversible_at" timestamptz,
  "failed_at" timestamptz,
  "provider_metadata" jsonb NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_payment_asset_upper" CHECK (asset_code = upper(asset_code)),
  CONSTRAINT "chk_payment_amount" CHECK (amount > 0),
  CONSTRAINT "chk_payment_external_operation_pair" CHECK ((external_transaction_id IS NULL) = (operation_index IS NULL)),
  CONSTRAINT "chk_payment_irreversible" CHECK ((state <> 'irreversible') OR irreversible_at IS NOT NULL)
);

CREATE TABLE "commerce"."purchase" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid NOT NULL,
  "shop_offer_id" uuid NOT NULL,
  "shop_offer_price_id" uuid NOT NULL,
  "payment_transaction_id" uuid UNIQUE,
  "status" commerce.purchase_status NOT NULL DEFAULT 'created',
  "collectible_instance_id" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "completed_at" timestamptz,
  "failure_code" varchar(64),
  CONSTRAINT "chk_purchase_fulfilled" CHECK ((status <> 'fulfilled') OR (payment_transaction_id IS NOT NULL AND collectible_instance_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE "tournament"."tournament" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" varchar(160) NOT NULL,
  "description" text NOT NULL,
  "organizer_type" tournament.organizer_type NOT NULL,
  "organizer_player_id" uuid,
  "format" tournament.tournament_format NOT NULL,
  "status" tournament.tournament_status NOT NULL DEFAULT 'draft',
  "max_players" integer NOT NULL,
  "registration_opens_at" timestamptz,
  "registration_closes_at" timestamptz,
  "scheduled_start_at" timestamptz,
  "entry_asset_code" varchar(16) NOT NULL,
  "entry_amount" numeric(20,8) NOT NULL,
  "treasury_hive_account" varchar(16) NOT NULL,
  "rules_version" smallint NOT NULL DEFAULT 1,
  "rules" jsonb NOT NULL DEFAULT '{}',
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  "row_version" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "chk_tournament_community_organizer" CHECK (organizer_type <> 'community' OR organizer_player_id IS NOT NULL),
  CONSTRAINT "chk_tournament_max_players" CHECK (max_players > 1),
  CONSTRAINT "chk_tournament_entry_asset_upper" CHECK (entry_asset_code = upper(entry_asset_code)),
  CONSTRAINT "chk_tournament_entry_amount" CHECK (entry_amount > 0),
  CONSTRAINT "chk_tournament_treasury_lower" CHECK (treasury_hive_account = lower(treasury_hive_account)),
  CONSTRAINT "chk_tournament_rules_version" CHECK (rules_version > 0),
  CONSTRAINT "chk_tournament_registration_window" CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL OR registration_closes_at > registration_opens_at),
  CONSTRAINT "chk_tournament_start_after_registration" CHECK (registration_closes_at IS NULL OR scheduled_start_at IS NULL OR scheduled_start_at >= registration_closes_at)
);

CREATE TABLE "tournament"."tournament_entry" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tournament_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "status" tournament.entry_status NOT NULL DEFAULT 'pending_payment',
  "entry_payment_transaction_id" uuid UNIQUE,
  "registered_at" timestamptz NOT NULL DEFAULT (now()),
  "checked_in_at" timestamptz,
  "seed" integer,
  "final_rank" integer,
  "terminal_reason" text,
  "completed_at" timestamptz,
  CONSTRAINT "chk_tournament_entry_seed" CHECK (seed IS NULL OR seed > 0),
  CONSTRAINT "chk_tournament_entry_rank" CHECK (final_rank IS NULL OR final_rank > 0)
);

CREATE TABLE "tournament"."prize_rule" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tournament_id" uuid NOT NULL,
  "placement" integer NOT NULL,
  "rule_type" tournament.prize_rule_type NOT NULL,
  "percentage" numeric(7,4),
  "fixed_amount" numeric(20,8),
  "asset_code" varchar(16) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_prize_rule_placement" CHECK (placement > 0),
  CONSTRAINT "chk_prize_rule_asset_upper" CHECK (asset_code = upper(asset_code)),
  CONSTRAINT "chk_prize_rule_value" CHECK ((rule_type = 'percentage' AND percentage > 0 AND percentage <= 100 AND fixed_amount IS NULL) OR (rule_type = 'fixed' AND fixed_amount > 0 AND percentage IS NULL))
);

CREATE TABLE "tournament"."tournament_match" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tournament_id" uuid NOT NULL,
  "stage_number" integer NOT NULL,
  "bracket_position" integer,
  "sequence_number" integer NOT NULL,
  "status" tournament.match_status NOT NULL DEFAULT 'scheduled',
  "scheduled_at" timestamptz,
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "winning_entry_id" uuid,
  "result_version" smallint NOT NULL DEFAULT 1,
  "result_summary" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_tournament_match_sequence" CHECK (stage_number > 0 AND sequence_number > 0),
  CONSTRAINT "chk_tournament_match_position" CHECK (bracket_position IS NULL OR bracket_position > 0),
  CONSTRAINT "chk_tournament_match_result_version" CHECK (result_version > 0),
  CONSTRAINT "chk_tournament_match_end_requires_start" CHECK (ended_at IS NULL OR started_at IS NOT NULL)
);

CREATE TABLE "tournament"."match_entry" (
  "tournament_match_id" uuid NOT NULL,
  "tournament_entry_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "seed_position" integer,
  "outcome" tournament.match_outcome,
  "score" numeric(18,4),
  CONSTRAINT "chk_match_entry_seed" CHECK (seed_position IS NULL OR seed_position > 0),
  PRIMARY KEY ("tournament_match_id", "tournament_entry_id")
);

CREATE TABLE "tournament"."match_game_round" (
  "tournament_match_id" uuid NOT NULL,
  "game_round_id" uuid UNIQUE NOT NULL,
  "round_sequence" integer NOT NULL,
  CONSTRAINT "chk_match_game_round_sequence" CHECK (round_sequence > 0),
  PRIMARY KEY ("tournament_match_id", "game_round_id")
);

CREATE TABLE "tournament"."entry_score" (
  "tournament_entry_id" uuid PRIMARY KEY NOT NULL,
  "aggregate_score" numeric(24,4) NOT NULL DEFAULT 0,
  "wins" integer NOT NULL DEFAULT 0,
  "losses" integer NOT NULL DEFAULT 0,
  "rounds_played" integer NOT NULL DEFAULT 0,
  "last_recalculated_at" timestamptz NOT NULL,
  CONSTRAINT "chk_entry_score_counts" CHECK (wins >= 0 AND losses >= 0 AND rounds_played >= 0)
);

CREATE TABLE "tournament"."payout" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tournament_id" uuid NOT NULL,
  "tournament_entry_id" uuid NOT NULL,
  "placement" integer NOT NULL,
  "asset_code" varchar(16) NOT NULL,
  "amount" numeric(20,8) NOT NULL,
  "payment_transaction_id" uuid UNIQUE NOT NULL,
  "status" tournament.payout_status NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "processing_at" timestamptz,
  "paid_at" timestamptz,
  "failed_at" timestamptz,
  CONSTRAINT "chk_tournament_payout_placement" CHECK (placement > 0),
  CONSTRAINT "chk_tournament_payout_asset_upper" CHECK (asset_code = upper(asset_code)),
  CONSTRAINT "chk_tournament_payout_amount" CHECK (amount > 0),
  CONSTRAINT "chk_tournament_payout_paid" CHECK ((status <> 'paid') OR paid_at IS NOT NULL)
);

CREATE TABLE "hive_projection"."block_checkpoint" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source" varchar(64) NOT NULL,
  "block_number" bigint NOT NULL,
  "block_id" varchar(128) NOT NULL,
  "previous_block_id" varchar(128),
  "block_timestamp" timestamptz NOT NULL,
  "state" hive_projection.operation_state NOT NULL DEFAULT 'included',
  "observed_at" timestamptz NOT NULL DEFAULT (now()),
  "irreversible_at" timestamptz,
  "reverted_at" timestamptz,
  CONSTRAINT "chk_block_checkpoint_height" CHECK (block_number >= 0),
  CONSTRAINT "chk_block_checkpoint_irreversible" CHECK ((state <> 'irreversible') OR irreversible_at IS NOT NULL),
  CONSTRAINT "chk_block_checkpoint_reverted" CHECK ((state <> 'reverted') OR reverted_at IS NOT NULL),
  CONSTRAINT "chk_block_checkpoint_state_evidence" CHECK ((state = 'included' AND irreversible_at IS NULL AND reverted_at IS NULL) OR (state = 'irreversible' AND irreversible_at IS NOT NULL AND reverted_at IS NULL) OR (state = 'reverted' AND irreversible_at IS NULL AND reverted_at IS NOT NULL))
);

CREATE TABLE "hive_projection"."operation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "checkpoint_id" uuid NOT NULL,
  "source_operation_id" varchar(128) NOT NULL,
  "transaction_id" varchar(128),
  "operation_index" integer NOT NULL,
  "is_virtual" boolean NOT NULL DEFAULT false,
  "block_number" bigint NOT NULL,
  "block_id" varchar(128) NOT NULL,
  "block_timestamp" timestamptz NOT NULL,
  "operation_type" varchar(64) NOT NULL,
  "primary_account" varchar(16) NOT NULL,
  "required_authority" hive_projection.authority_type,
  "application_id" varchar(64),
  "payload" jsonb NOT NULL,
  "state" hive_projection.operation_state NOT NULL,
  "validation_state" hive_projection.validation_state NOT NULL DEFAULT 'pending',
  "rejection_reason" varchar(128),
  "validated_at" timestamptz,
  "observed_at" timestamptz NOT NULL DEFAULT (now()),
  "irreversible_at" timestamptz,
  "reverted_at" timestamptz,
  CONSTRAINT "chk_hive_operation_position" CHECK (operation_index >= 0 AND block_number >= 0),
  CONSTRAINT "chk_hive_operation_transaction_identity" CHECK (is_virtual OR transaction_id IS NOT NULL),
  CONSTRAINT "chk_hive_operation_account_lower" CHECK (primary_account = lower(primary_account)),
  CONSTRAINT "chk_hive_operation_irreversible" CHECK ((state <> 'irreversible') OR irreversible_at IS NOT NULL),
  CONSTRAINT "chk_hive_operation_reverted" CHECK ((state <> 'reverted') OR reverted_at IS NOT NULL),
  CONSTRAINT "chk_hive_operation_validated" CHECK ((validation_state NOT IN ('accepted', 'rejected')) OR validated_at IS NOT NULL),
  CONSTRAINT "chk_hive_operation_rejection" CHECK ((validation_state <> 'rejected') OR rejection_reason IS NOT NULL),
  CONSTRAINT "chk_hive_operation_state_evidence" CHECK ((state = 'included' AND irreversible_at IS NULL AND reverted_at IS NULL) OR (state = 'irreversible' AND irreversible_at IS NOT NULL AND reverted_at IS NULL) OR (state = 'reverted' AND irreversible_at IS NULL AND reverted_at IS NOT NULL)),
  CONSTRAINT "chk_hive_operation_validation_evidence" CHECK ((validation_state = 'pending' AND validated_at IS NULL AND rejection_reason IS NULL) OR (validation_state = 'accepted' AND validated_at IS NOT NULL AND rejection_reason IS NULL) OR (validation_state = 'rejected' AND validated_at IS NOT NULL AND rejection_reason IS NOT NULL))
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

CREATE TABLE "hive_projection"."collectible_event" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "operation_id" uuid UNIQUE NOT NULL,
  "schema_version" smallint NOT NULL,
  "event_type" hive_projection.collectible_event_type NOT NULL,
  "collectible_id" uuid NOT NULL,
  "collectible_definition_id" uuid NOT NULL,
  "owner_hive_username" varchar(16) NOT NULL,
  "issuer_hive_username" varchar(16) NOT NULL,
  "metadata_uri" text,
  "metadata_sha256" char(64),
  "issuance_reason" varchar(64),
  "payment_transaction_id" uuid,
  "occurred_at" timestamptz NOT NULL,
  "validation_state" hive_projection.validation_state NOT NULL DEFAULT 'pending',
  "rejection_reason" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_collectible_event_schema_version" CHECK (schema_version > 0),
  CONSTRAINT "chk_collectible_event_owner_lower" CHECK (owner_hive_username = lower(owner_hive_username)),
  CONSTRAINT "chk_collectible_event_issuer_lower" CHECK (issuer_hive_username = lower(issuer_hive_username)),
  CONSTRAINT "chk_collectible_event_rejection" CHECK ((validation_state <> 'rejected') OR rejection_reason IS NOT NULL)
);

CREATE TABLE "hive_projection"."asset_transfer" (
  "id" uuid PRIMARY KEY NOT NULL,
  "operation_id" uuid UNIQUE NOT NULL,
  "rail" commerce.payment_rail NOT NULL,
  "asset_code" varchar(16) NOT NULL,
  "amount" numeric(20,8) NOT NULL,
  "sender_hive_account" varchar(16) NOT NULL,
  "recipient_hive_account" varchar(16) NOT NULL,
  "memo" text,
  "correlation_reference" varchar(256),
  "hive_engine_execution_reference" varchar(128),
  "hive_engine_execution_state" hive_projection.hive_engine_execution_state NOT NULL DEFAULT 'not_applicable',
  "irreversible_at" timestamptz,
  "consumed_by_payment_id" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_asset_transfer_rail" CHECK (rail IN ('hive', 'hive_engine')),
  CONSTRAINT "chk_asset_transfer_asset_upper" CHECK (asset_code = upper(asset_code)),
  CONSTRAINT "chk_asset_transfer_amount" CHECK (amount > 0),
  CONSTRAINT "chk_asset_transfer_sender_lower" CHECK (sender_hive_account = lower(sender_hive_account)),
  CONSTRAINT "chk_asset_transfer_recipient_lower" CHECK (recipient_hive_account = lower(recipient_hive_account))
);

CREATE TABLE "hive_projection"."community_post" (
  "id" uuid PRIMARY KEY NOT NULL,
  "author_hive_username" varchar(16) NOT NULL,
  "permlink" varchar(256) NOT NULL,
  "created_operation_id" uuid UNIQUE NOT NULL,
  "latest_operation_id" uuid NOT NULL,
  "title" varchar(256) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_on_hive_at" timestamptz NOT NULL,
  "updated_on_hive_at" timestamptz NOT NULL,
  "cached_vote_count" integer NOT NULL DEFAULT 0,
  "cached_reward_amount" numeric(20,8) NOT NULL DEFAULT 0,
  "reward_asset_code" varchar(16),
  "last_synced_at" timestamptz NOT NULL,
  CONSTRAINT "chk_community_post_author_lower" CHECK (author_hive_username = lower(author_hive_username)),
  CONSTRAINT "chk_community_post_votes" CHECK (cached_vote_count >= 0),
  CONSTRAINT "chk_community_post_reward" CHECK (cached_reward_amount >= 0)
);

CREATE TABLE "hive_projection"."community_vote" (
  "id" uuid PRIMARY KEY NOT NULL,
  "community_post_id" uuid NOT NULL,
  "voter_hive_username" varchar(16) NOT NULL,
  "latest_operation_id" uuid NOT NULL,
  "vote_weight" integer NOT NULL,
  "state" hive_projection.operation_state NOT NULL,
  "voted_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "chk_community_vote_voter_lower" CHECK (voter_hive_username = lower(voter_hive_username)),
  CONSTRAINT "chk_community_vote_weight" CHECK (vote_weight BETWEEN -10000 AND 10000)
);

CREATE TABLE "hive_projection"."transaction_intent" (
  "id" uuid PRIMARY KEY NOT NULL,
  "idempotency_key" varchar(128) UNIQUE NOT NULL,
  "player_id" uuid,
  "auth_session_id" uuid,
  "operation_kind" varchar(64) NOT NULL,
  "required_authority" hive_projection.authority_type NOT NULL,
  "canonical_operation_hash" char(64) NOT NULL,
  "authorization_mode" hive_projection.authorization_mode NOT NULL,
  "hive_signing_provider" identity.signing_provider,
  "custody_key_reference_id" uuid,
  "official_service_role" hive_projection.service_account_role,
  "allowlist_policy_version" varchar(32) NOT NULL,
  "authorization_validated_at" timestamptz NOT NULL,
  "state" hive_projection.transaction_state NOT NULL DEFAULT 'requested',
  "requested_at" timestamptz NOT NULL DEFAULT (now()),
  "expires_at" timestamptz NOT NULL,
  "hive_transaction_id" varchar(128),
  "failure_code" varchar(64),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_transaction_intent_expiry" CHECK (expires_at > requested_at),
  CONSTRAINT "chk_transaction_intent_external" CHECK ((authorization_mode <> 'external_wallet') OR (player_id IS NOT NULL AND auth_session_id IS NOT NULL AND hive_signing_provider IS NOT NULL AND hive_signing_provider <> 'custodial_service' AND custody_key_reference_id IS NULL AND official_service_role IS NULL)),
  CONSTRAINT "chk_transaction_intent_custodial" CHECK ((authorization_mode <> 'custodial_player') OR (player_id IS NOT NULL AND auth_session_id IS NOT NULL AND hive_signing_provider = 'custodial_service' AND custody_key_reference_id IS NOT NULL AND official_service_role IS NULL)),
  CONSTRAINT "chk_transaction_intent_official" CHECK ((authorization_mode <> 'official_service') OR (player_id IS NULL AND auth_session_id IS NULL AND hive_signing_provider IS NULL AND custody_key_reference_id IS NULL AND official_service_role IS NOT NULL))
);

CREATE TABLE "hive_projection"."rc_delegation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_id" uuid,
  "provisioning_id" uuid,
  "recipient_hive_username" varchar(16) NOT NULL,
  "delegator_hive_account" varchar(16) NOT NULL,
  "delegator_kind" hive_projection.rc_delegator_kind NOT NULL,
  "delegator_service_role" hive_projection.service_account_role,
  "purpose" hive_projection.rc_delegation_purpose NOT NULL,
  "required_authority" hive_projection.authority_type NOT NULL DEFAULT 'posting',
  "application_id" varchar(64) NOT NULL DEFAULT 'rc',
  "payload_operation" varchar(64) NOT NULL DEFAULT 'delegate_rc',
  "delegated_max_rc" numeric(30,0) NOT NULL,
  "grant_operation_id" uuid,
  "reclaim_operation_id" uuid,
  "status" hive_projection.rc_delegation_status NOT NULL DEFAULT 'pending',
  "granted_at" timestamptz,
  "last_used_at" timestamptz,
  "reclaimed_at" timestamptz,
  "eligible_at" timestamptz,
  "cooldown_until" timestamptz,
  "eligibility_metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_rc_delegation_subject" CHECK (player_id IS NOT NULL OR provisioning_id IS NOT NULL),
  CONSTRAINT "chk_rc_delegation_recipient_lower" CHECK (recipient_hive_username = lower(recipient_hive_username)),
  CONSTRAINT "chk_rc_delegation_delegator_lower" CHECK (delegator_hive_account = lower(delegator_hive_account)),
  CONSTRAINT "chk_rc_delegation_owner" CHECK ((delegator_kind = 'approved_signup_sponsor' AND delegator_service_role IS NULL) OR (delegator_kind = 'platform_rc_support' AND delegator_service_role = 'rc_support')),
  CONSTRAINT "chk_rc_delegation_initial" CHECK ((purpose <> 'initial_provisioning') OR (provisioning_id IS NOT NULL AND delegator_kind = 'approved_signup_sponsor')),
  CONSTRAINT "chk_rc_delegation_general" CHECK ((purpose <> 'general_support') OR (player_id IS NOT NULL AND delegator_kind = 'platform_rc_support')),
  CONSTRAINT "chk_rc_delegation_wrapper" CHECK (required_authority = 'posting' AND application_id = 'rc' AND payload_operation = 'delegate_rc'),
  CONSTRAINT "chk_rc_delegation_max_rc" CHECK (delegated_max_rc > 0),
  CONSTRAINT "chk_rc_delegation_cooldown" CHECK (cooldown_until IS NULL OR eligible_at IS NULL OR cooldown_until >= eligible_at)
);

CREATE TABLE "hive_projection"."sync_cursor" (
  "source" varchar(64) PRIMARY KEY NOT NULL,
  "endpoint_url" text NOT NULL,
  "last_processed_block" bigint NOT NULL DEFAULT 0,
  "last_irreversible_block" bigint NOT NULL DEFAULT 0,
  "last_successful_sync_at" timestamptz,
  "health" hive_projection.sync_health NOT NULL DEFAULT 'healthy',
  "last_error_code" varchar(64),
  "updated_at" timestamptz NOT NULL DEFAULT (now()),
  CONSTRAINT "chk_sync_cursor_processed_block" CHECK (last_processed_block >= 0),
  CONSTRAINT "chk_sync_cursor_irreversible_block" CHECK (last_irreversible_block >= 0 AND last_irreversible_block <= last_processed_block)
);

CREATE UNIQUE INDEX "uq_external_identity_subject" ON "identity"."external_identity" ("provider", "verified_issuer", "subject_lookup_hash");

CREATE INDEX "idx_external_identity_status" ON "identity"."external_identity" ("status", "last_authenticated_at");

CREATE INDEX "idx_provisioning_username" ON "identity"."hive_account_provisioning" ("requested_hive_username", "state");

CREATE INDEX "idx_provisioning_retry" ON "identity"."hive_account_provisioning" ("state", "next_retry_at");

CREATE UNIQUE INDEX "uq_provisioning_sponsor_request" ON "identity"."hive_account_provisioning" ("sponsor_program", "sponsor_request_reference");

CREATE INDEX "idx_provisioning_creation_tx" ON "identity"."hive_account_provisioning" ("account_creation_transaction_id");

CREATE INDEX "idx_custody_key_provisioning_role" ON "identity"."custody_key_reference" ("provisioning_id", "authority_role", "state");

CREATE INDEX "idx_custody_key_player_role" ON "identity"."custody_key_reference" ("player_id", "authority_role", "state");

CREATE INDEX "idx_hive_account_claim_player_state" ON "identity"."hive_account_claim" ("player_id", "state");

CREATE INDEX "idx_hive_account_claim_retry" ON "identity"."hive_account_claim" ("state", "next_retry_at");

CREATE INDEX "idx_hive_account_claim_recovery" ON "identity"."hive_account_claim" ("selected_recovery_hive_account");

CREATE INDEX "idx_disclosure_ack_external" ON "identity"."public_record_disclosure_acknowledgment" ("external_identity_id", "disclosure_version");

CREATE INDEX "idx_disclosure_ack_player" ON "identity"."public_record_disclosure_acknowledgment" ("player_id", "disclosure_version");

CREATE INDEX "idx_disclosure_ack_version" ON "identity"."public_record_disclosure_acknowledgment" ("disclosure_version");

CREATE INDEX "idx_auth_session_player" ON "identity"."auth_session" ("player_id");

CREATE INDEX "idx_auth_session_external_identity" ON "identity"."auth_session" ("external_identity_id");

CREATE INDEX "idx_auth_session_expiry" ON "identity"."auth_session" ("expires_at");

CREATE INDEX "idx_auth_session_player_revoked" ON "identity"."auth_session" ("player_id", "revoked_at");

CREATE UNIQUE INDEX "uq_player_platform_setting" ON "identity"."player_platform_setting" ("player_id", "platform");

CREATE INDEX "idx_platform_role_approval_target" ON "identity"."platform_role_approval" ("target_player_id", "role", "state");

CREATE INDEX "idx_platform_role_approval_requester" ON "identity"."platform_role_approval" ("requested_by_player_id", "requested_at");

CREATE INDEX "idx_platform_role_approval_approver" ON "identity"."platform_role_approval" ("approved_by_player_id", "decided_at");

CREATE INDEX "idx_platform_role_approval_pending" ON "identity"."platform_role_approval" ("state", "expires_at");

CREATE INDEX "idx_platform_role_assignment_player" ON "identity"."platform_role_assignment" ("player_id", "role", "valid_from");

CREATE INDEX "idx_platform_role_assignment_role" ON "identity"."platform_role_assignment" ("role", "valid_until");

CREATE INDEX "idx_platform_role_assignment_granter" ON "identity"."platform_role_assignment" ("granted_by_player_id", "created_at");

CREATE INDEX "idx_platform_role_assignment_revoker" ON "identity"."platform_role_assignment" ("revoked_by_player_id", "revoked_at");

CREATE INDEX "idx_authorization_audit_actor" ON "identity"."authorization_audit_event" ("actor_player_id", "occurred_at");

CREATE INDEX "idx_authorization_audit_service" ON "identity"."authorization_audit_event" ("actor_service_name", "occurred_at");

CREATE INDEX "idx_authorization_audit_subject" ON "identity"."authorization_audit_event" ("subject_player_id", "occurred_at");

CREATE INDEX "idx_authorization_audit_decision" ON "identity"."authorization_audit_event" ("decision", "action", "occurred_at");

CREATE INDEX "idx_authorization_audit_correlation" ON "identity"."authorization_audit_event" ("correlation_id");

CREATE INDEX "idx_friend_request_recipient" ON "social"."friend_request" ("recipient_player_id", "status", "sent_at");

CREATE INDEX "idx_friend_request_requester" ON "social"."friend_request" ("requester_player_id", "status", "sent_at");

CREATE UNIQUE INDEX "uq_friendship_pair" ON "social"."friendship" ("player_low_id", "player_high_id");

CREATE INDEX "idx_friendship_high" ON "social"."friendship" ("player_high_id");

CREATE INDEX "idx_player_block_blocked" ON "social"."player_block" ("blocked_player_id");

CREATE INDEX "idx_lobby_invitation_inbox" ON "social"."lobby_invitation" ("invitee_player_id", "status", "expires_at");

CREATE INDEX "idx_lobby_invitation_lobby" ON "social"."lobby_invitation" ("lobby_id", "status");

CREATE INDEX "idx_lobby_invitation_inviter" ON "social"."lobby_invitation" ("inviter_player_id");

CREATE INDEX "idx_notification_inbox" ON "social"."notification" ("recipient_player_id", "read_at", "created_at");

CREATE INDEX "idx_notification_expiry" ON "social"."notification" ("expires_at");

CREATE INDEX "idx_lobby_discovery" ON "game"."lobby" ("region_code", "visibility", "closed_at");

CREATE INDEX "idx_lobby_current_host" ON "game"."lobby" ("current_host_player_id");

CREATE INDEX "idx_lobby_access_token_lobby" ON "game"."lobby_access_token" ("lobby_id", "expires_at");

CREATE INDEX "idx_lobby_access_token_creator" ON "game"."lobby_access_token" ("created_by_player_id");

CREATE INDEX "idx_lobby_membership_lobby" ON "game"."lobby_membership" ("lobby_id", "joined_at");

CREATE INDEX "idx_lobby_membership_player" ON "game"."lobby_membership" ("player_id", "joined_at");

CREATE INDEX "idx_lobby_host_history" ON "game"."lobby_host_assignment" ("lobby_id", "started_at");

CREATE INDEX "idx_lobby_host_player" ON "game"."lobby_host_assignment" ("host_player_id");

CREATE INDEX "idx_lobby_configuration_map" ON "game"."lobby_configuration" ("map_version_id");

CREATE UNIQUE INDEX "uq_game_round_lobby_sequence" ON "game"."game_round" ("lobby_id", "sequence_number");

CREATE INDEX "idx_game_round_status_time" ON "game"."game_round" ("status", "started_at");

CREATE INDEX "idx_game_round_map_time" ON "game"."game_round" ("map_version_id", "started_at");

CREATE UNIQUE INDEX "uq_round_participant_player" ON "game"."round_participant" ("round_id", "player_id");

CREATE INDEX "idx_round_participant_history" ON "game"."round_participant" ("player_id", "created_at");

CREATE UNIQUE INDEX "uq_round_discovery_sequence" ON "game"."round_discovery" ("round_id", "discovery_sequence");

CREATE UNIQUE INDEX "uq_round_discovery_hider" ON "game"."round_discovery" ("round_id", "hider_player_id");

CREATE INDEX "idx_round_discovery_round_hunter" ON "game"."round_discovery" ("round_id", "hunter_player_id");

CREATE INDEX "idx_round_discovery_hunter" ON "game"."round_discovery" ("hunter_player_id");

CREATE UNIQUE INDEX "uq_round_like_voter" ON "game"."round_like" ("round_id", "voter_player_id");

CREATE INDEX "idx_round_like_target" ON "game"."round_like" ("round_id", "target_hider_player_id");

CREATE INDEX "idx_round_like_voter_player" ON "game"."round_like" ("voter_player_id");

CREATE UNIQUE INDEX "uq_round_result_revision_number" ON "game"."round_result_revision" ("round_id", "revision_number");

CREATE UNIQUE INDEX "uq_round_result_revision_round" ON "game"."round_result_revision" ("id", "round_id");

CREATE INDEX "idx_round_result_revision_history" ON "game"."round_result_revision" ("round_id", "revision_type", "created_at");

CREATE INDEX "idx_match_publication_request_retry" ON "game"."match_publication_request" ("state", "next_retry_at");

CREATE INDEX "idx_match_publication_request_round" ON "game"."match_publication_request" ("round_id", "request_type", "state");

CREATE INDEX "idx_match_outbox_retry" ON "game"."match_publication_outbox" ("state", "next_retry_at");

CREATE INDEX "idx_match_outbox_event_type" ON "game"."match_publication_outbox" ("event_type", "created_at");

CREATE INDEX "idx_match_outbox_publisher" ON "game"."match_publication_outbox" ("publisher_hive_account", "state");

CREATE INDEX "idx_match_outbox_transaction" ON "game"."match_publication_outbox" ("hive_transaction_id");

CREATE UNIQUE INDEX "uq_match_publication_item_position" ON "game"."match_publication_item" ("outbox_id", "result_position");

CREATE INDEX "idx_match_publication_item_revision" ON "game"."match_publication_item" ("result_revision_id", "round_id");

CREATE INDEX "idx_match_publication_item_round" ON "game"."match_publication_item" ("round_id", "outbox_id");

CREATE INDEX "idx_achievement_badge_definition" ON "game"."achievement_definition" ("badge_collectible_definition_id");

CREATE UNIQUE INDEX "uq_player_achievement" ON "game"."player_achievement" ("player_id", "achievement_definition_id");

CREATE INDEX "idx_player_achievement_definition" ON "game"."player_achievement" ("achievement_definition_id");

CREATE INDEX "idx_player_achievement_status" ON "game"."player_achievement" ("status", "earned_at");

CREATE INDEX "idx_map_discovery" ON "content"."map" ("lifecycle", "origin");

CREATE INDEX "idx_map_creator" ON "content"."map" ("creator_player_id", "created_at");

CREATE UNIQUE INDEX "uq_map_version_number" ON "content"."map_version" ("map_id", "version_number");

CREATE UNIQUE INDEX "uq_map_version_id_map" ON "content"."map_version" ("id", "map_id");

CREATE INDEX "idx_map_version_map_status" ON "content"."map_version" ("map_id", "status");

CREATE INDEX "idx_map_version_publication" ON "content"."map_version" ("status", "published_at");

CREATE INDEX "idx_map_lifecycle_event_map" ON "content"."map_lifecycle_event" ("map_id", "occurred_at");

CREATE INDEX "idx_map_lifecycle_event_state" ON "content"."map_lifecycle_event" ("new_lifecycle", "occurred_at");

CREATE INDEX "idx_map_lifecycle_event_version" ON "content"."map_lifecycle_event" ("map_version_id", "map_id");

CREATE INDEX "idx_map_lifecycle_event_actor" ON "content"."map_lifecycle_event" ("changed_by_player_id");

CREATE UNIQUE INDEX "uq_map_asset_order" ON "content"."map_asset" ("map_version_id", "kind", "sort_order");

CREATE INDEX "idx_map_review_version" ON "content"."map_review" ("map_version_id", "reviewed_at");

CREATE INDEX "idx_map_review_reviewer" ON "content"."map_review" ("reviewer_player_id", "reviewed_at");

CREATE INDEX "idx_map_tag_tag" ON "content"."map_tag" ("tag_id");

CREATE UNIQUE INDEX "uq_map_distribution_platform" ON "content"."map_distribution" ("map_version_id", "platform");

CREATE INDEX "idx_map_distribution_availability" ON "content"."map_distribution" ("platform", "state", "required_game_build_version");

CREATE INDEX "idx_map_showcase_map" ON "content"."map_showcase" ("map_id", "state");

CREATE INDEX "idx_map_showcase_version" ON "content"."map_showcase" ("map_version_id", "map_id");

CREATE INDEX "idx_map_showcase_creator" ON "content"."map_showcase" ("creator_player_id", "created_at");

CREATE INDEX "idx_collectible_definition_catalog" ON "commerce"."collectible_definition" ("kind", "availability");

CREATE UNIQUE INDEX "uq_collectible_asset_order" ON "commerce"."collectible_asset" ("collectible_definition_id", "asset_kind", "platform", "sort_order");

CREATE INDEX "idx_collectible_instance_owner" ON "commerce"."collectible_instance" ("owner_player_id", "state");

CREATE INDEX "idx_collectible_instance_definition" ON "commerce"."collectible_instance" ("collectible_definition_id", "state");

CREATE INDEX "idx_collectible_instance_issued_event" ON "commerce"."collectible_instance" ("issued_event_id", "id", "collectible_definition_id");

CREATE INDEX "idx_collectible_instance_revoked_event" ON "commerce"."collectible_instance" ("revoked_event_id", "id", "collectible_definition_id");

CREATE INDEX "idx_player_loadout_history" ON "commerce"."player_loadout" ("player_id", "equipment_slot", "equipped_at");

CREATE INDEX "idx_player_loadout_collectible" ON "commerce"."player_loadout" ("collectible_instance_id", "equipped_at");

CREATE INDEX "idx_shop_offer_definition" ON "commerce"."shop_offer" ("collectible_definition_id");

CREATE INDEX "idx_shop_offer_availability" ON "commerce"."shop_offer" ("state", "starts_at", "ends_at");

CREATE UNIQUE INDEX "uq_shop_offer_price" ON "commerce"."shop_offer_price" ("shop_offer_id", "payment_rail", "asset_code");

CREATE UNIQUE INDEX "uq_shop_offer_price_offer_pair" ON "commerce"."shop_offer_price" ("id", "shop_offer_id");

CREATE UNIQUE INDEX "uq_payment_external_operation" ON "commerce"."payment_transaction" ("rail", "external_transaction_id", "operation_index");

CREATE INDEX "idx_payment_player_purpose" ON "commerce"."payment_transaction" ("player_id", "purpose", "requested_at");

CREATE INDEX "idx_payment_state" ON "commerce"."payment_transaction" ("state", "requested_at");

CREATE INDEX "idx_payment_correlation" ON "commerce"."payment_transaction" ("correlation_reference");

CREATE INDEX "idx_purchase_player" ON "commerce"."purchase" ("player_id", "created_at");

CREATE INDEX "idx_purchase_offer" ON "commerce"."purchase" ("shop_offer_id");

CREATE INDEX "idx_purchase_price_offer" ON "commerce"."purchase" ("shop_offer_price_id", "shop_offer_id");

CREATE INDEX "idx_purchase_status" ON "commerce"."purchase" ("status", "created_at");

CREATE INDEX "idx_tournament_status_start" ON "tournament"."tournament" ("status", "scheduled_start_at");

CREATE INDEX "idx_tournament_organizer" ON "tournament"."tournament" ("organizer_player_id", "status");

CREATE UNIQUE INDEX "uq_tournament_entry_player" ON "tournament"."tournament_entry" ("tournament_id", "player_id");

CREATE UNIQUE INDEX "uq_tournament_entry_id_tournament" ON "tournament"."tournament_entry" ("id", "tournament_id");

CREATE INDEX "idx_tournament_entry_status" ON "tournament"."tournament_entry" ("tournament_id", "status");

CREATE INDEX "idx_tournament_entry_player" ON "tournament"."tournament_entry" ("player_id");

CREATE UNIQUE INDEX "uq_tournament_prize_rule" ON "tournament"."prize_rule" ("tournament_id", "placement", "asset_code");

CREATE UNIQUE INDEX "uq_tournament_match_sequence" ON "tournament"."tournament_match" ("tournament_id", "sequence_number");

CREATE UNIQUE INDEX "uq_tournament_match_id_tournament" ON "tournament"."tournament_match" ("id", "tournament_id");

CREATE INDEX "idx_tournament_match_winner" ON "tournament"."tournament_match" ("winning_entry_id", "tournament_id");

CREATE INDEX "idx_tournament_match_winner_entry" ON "tournament"."tournament_match" ("id", "winning_entry_id");

CREATE INDEX "idx_tournament_match_bracket" ON "tournament"."tournament_match" ("tournament_id", "stage_number", "bracket_position");

CREATE INDEX "idx_match_entry_match_tournament" ON "tournament"."match_entry" ("tournament_match_id", "tournament_id");

CREATE INDEX "idx_match_entry_entry_tournament" ON "tournament"."match_entry" ("tournament_entry_id", "tournament_id");

CREATE INDEX "idx_match_entry_entry" ON "tournament"."match_entry" ("tournament_entry_id");

CREATE UNIQUE INDEX "uq_match_game_round_sequence" ON "tournament"."match_game_round" ("tournament_match_id", "round_sequence");

CREATE INDEX "idx_tournament_payout_status" ON "tournament"."payout" ("tournament_id", "status");

CREATE INDEX "idx_tournament_payout_recipient" ON "tournament"."payout" ("tournament_entry_id", "placement");

CREATE INDEX "idx_tournament_payout_entry" ON "tournament"."payout" ("tournament_entry_id", "tournament_id");

CREATE UNIQUE INDEX "uq_block_checkpoint_source_id" ON "hive_projection"."block_checkpoint" ("source", "block_id");

CREATE UNIQUE INDEX "uq_block_checkpoint_source_height_id" ON "hive_projection"."block_checkpoint" ("source", "block_number", "block_id");

CREATE INDEX "idx_block_checkpoint_source_height" ON "hive_projection"."block_checkpoint" ("source", "block_number");

CREATE INDEX "idx_block_checkpoint_parent" ON "hive_projection"."block_checkpoint" ("source", "previous_block_id");

CREATE INDEX "idx_block_checkpoint_state" ON "hive_projection"."block_checkpoint" ("source", "state", "block_number");

CREATE INDEX "idx_hive_operation_checkpoint" ON "hive_projection"."operation" ("checkpoint_id");

CREATE INDEX "idx_hive_operation_source_id" ON "hive_projection"."operation" ("source_operation_id");

CREATE INDEX "idx_hive_operation_tx_index" ON "hive_projection"."operation" ("transaction_id", "operation_index");

CREATE INDEX "idx_hive_operation_block" ON "hive_projection"."operation" ("block_number", "operation_index");

CREATE INDEX "idx_hive_operation_replay" ON "hive_projection"."operation" ("block_number", "block_id", "state");

CREATE INDEX "idx_hive_operation_type" ON "hive_projection"."operation" ("operation_type", "is_virtual", "block_number");

CREATE INDEX "idx_hive_operation_application" ON "hive_projection"."operation" ("application_id", "block_number");

CREATE INDEX "idx_hive_operation_account" ON "hive_projection"."operation" ("primary_account", "block_timestamp");

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

CREATE UNIQUE INDEX "uq_collectible_event_identity" ON "hive_projection"."collectible_event" ("event_id", "collectible_id", "collectible_definition_id");

CREATE INDEX "idx_collectible_event_instance" ON "hive_projection"."collectible_event" ("collectible_id", "event_type");

CREATE INDEX "idx_collectible_event_issuer" ON "hive_projection"."collectible_event" ("issuer_hive_username", "occurred_at");

CREATE INDEX "idx_collectible_event_payment" ON "hive_projection"."collectible_event" ("payment_transaction_id");

CREATE INDEX "idx_collectible_event_validation" ON "hive_projection"."collectible_event" ("validation_state", "created_at");

CREATE INDEX "idx_asset_transfer_recipient" ON "hive_projection"."asset_transfer" ("recipient_hive_account", "asset_code", "created_at");

CREATE INDEX "idx_asset_transfer_correlation" ON "hive_projection"."asset_transfer" ("correlation_reference");

CREATE UNIQUE INDEX "uq_community_post_author_permlink" ON "hive_projection"."community_post" ("author_hive_username", "permlink");

CREATE INDEX "idx_community_post_latest_operation" ON "hive_projection"."community_post" ("latest_operation_id");

CREATE INDEX "idx_community_post_created" ON "hive_projection"."community_post" ("created_on_hive_at");

CREATE UNIQUE INDEX "uq_community_vote_voter" ON "hive_projection"."community_vote" ("community_post_id", "voter_hive_username");

CREATE INDEX "idx_community_vote_operation" ON "hive_projection"."community_vote" ("latest_operation_id");

CREATE INDEX "idx_community_vote_voter" ON "hive_projection"."community_vote" ("voter_hive_username", "voted_at");

CREATE INDEX "idx_transaction_intent_player" ON "hive_projection"."transaction_intent" ("player_id", "requested_at");

CREATE INDEX "idx_transaction_intent_session" ON "hive_projection"."transaction_intent" ("auth_session_id", "requested_at");

CREATE INDEX "idx_transaction_intent_custody_key" ON "hive_projection"."transaction_intent" ("custody_key_reference_id", "requested_at");

CREATE INDEX "idx_transaction_intent_service_role" ON "hive_projection"."transaction_intent" ("official_service_role", "requested_at");

CREATE INDEX "idx_transaction_intent_state" ON "hive_projection"."transaction_intent" ("state", "expires_at");

CREATE INDEX "idx_transaction_intent_hive_tx" ON "hive_projection"."transaction_intent" ("hive_transaction_id");

CREATE INDEX "idx_rc_delegation_recipient" ON "hive_projection"."rc_delegation" ("recipient_hive_username", "status");

CREATE INDEX "idx_rc_delegation_delegator" ON "hive_projection"."rc_delegation" ("delegator_hive_account", "status");

CREATE INDEX "idx_rc_delegation_provisioning" ON "hive_projection"."rc_delegation" ("provisioning_id", "purpose");

CREATE INDEX "idx_rc_delegation_player" ON "hive_projection"."rc_delegation" ("player_id", "purpose", "status");

CREATE INDEX "idx_rc_delegation_grant_operation" ON "hive_projection"."rc_delegation" ("grant_operation_id");

CREATE INDEX "idx_rc_delegation_reclaim_operation" ON "hive_projection"."rc_delegation" ("reclaim_operation_id");

CREATE INDEX "idx_rc_delegation_eligibility" ON "hive_projection"."rc_delegation" ("status", "eligible_at", "cooldown_until");

COMMENT ON TABLE "identity"."player" IS 'Playable identity. Direct-Hive login may create it after signature verification; Google provisioning creates it only when the real Hive account, expected authorities, and initial RC are verified ready. No guest/pending player is stored.';

COMMENT ON COLUMN "identity"."player"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."external_identity" IS 'subject_lookup_hash is a keyed deterministic HMAC-SHA-256 of the canonical verified issuer/subject pair; the HMAC key and raw subject/token material remain outside PostgreSQL. Email is never an ownership key.';

COMMENT ON COLUMN "identity"."external_identity"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."hive_account_provisioning" IS 'One row is retried through partial and uncertain sponsor outcomes; no player or playable auth_session exists until ready. Migration makes requested_hive_username unique for every job except a terminal failure with no observed account, and immutable after any matching account is observed. Raw signup codes and sponsor API credentials are never stored.';

COMMENT ON COLUMN "identity"."hive_account_provisioning"."id" IS 'Application-generated UUIDv7; stable logical provisioning job';

COMMENT ON COLUMN "identity"."hive_account_provisioning"."sponsor_request_reference" IS 'Opaque, non-secret reference returned by the approved signup sponsor';

COMMENT ON TABLE "identity"."custody_key_reference" IS 'Stores only a Hive public key, an opaque provider reference, and non-secret lifecycle evidence. Migration adds partial unique indexes for one nondestroyed key per provisioning/player and authority role; four roles are required before keys_ready.';

COMMENT ON COLUMN "identity"."custody_key_reference"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."hive_account_claim" IS 'The two owner-authorized operations must share one transaction. Canonical authority text is public, deterministic operation input—not private material. Completion waits for the approximately 30-day recovery-account transition and changed_recovery_account verification. Migration adds one pending claim per player.';

COMMENT ON COLUMN "identity"."hive_account_claim"."id" IS 'Application-generated UUIDv7; stable claim request identity';

COMMENT ON TABLE "identity"."public_record_disclosure" IS 'Versioned product disclosure for permanent Hive match-summary fields; this is not a generic legal-consent table.';

COMMENT ON TABLE "identity"."public_record_disclosure_acknowledgment" IS 'The Google row is updated with player_id after provisioning instead of duplicated. Migration adds partial unique indexes per non-null external identity/player and disclosure version. No IP, device, browser, email, or token data is stored.';

COMMENT ON COLUMN "identity"."public_record_disclosure_acknowledgment"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."auth_session" IS 'Authentication and Hive signing are independent. This table contains only a hash of the game refresh token—never Google tokens or Hive keys—and exists only after a playable player exists. Migration adds a partial unique index on player_id WHERE revoked_at IS NULL.';

COMMENT ON COLUMN "identity"."auth_session"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "identity"."player_platform_setting"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."platform_role_approval" IS 'Two-person evidence for high-risk platform-role grants or extensions. Scope existence and agreement with the resulting assignment are enforced by migration triggers.';

COMMENT ON COLUMN "identity"."platform_role_approval"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."platform_role_assignment" IS 'Only staff/operator platform roles are assigned here. Player, lobby-host, map-creator, pending identity, and service capabilities remain derived from their owning boundaries.';

COMMENT ON COLUMN "identity"."platform_role_assignment"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "identity"."authorization_audit_event" IS 'Append-only, non-secret authorization evidence. Production retention is at least 180 days.';

COMMENT ON COLUMN "identity"."authorization_audit_event"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "social"."friend_request" IS 'Migration adds an expression/partial unique index preventing reversed duplicate pending requests.';

COMMENT ON COLUMN "social"."friend_request"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "social"."friendship"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "social"."lobby_invitation" IS 'Migration adds a partial unique index on lobby_id and invitee_player_id WHERE status is pending.';

COMMENT ON COLUMN "social"."lobby_invitation"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "social"."notification"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."lobby" IS 'Current host is a fast pointer synchronized transactionally with lobby_host_assignment. Migration adds a partial discovery index WHERE closed_at IS NULL.';

COMMENT ON COLUMN "game"."lobby"."id" IS 'Application-generated UUIDv7; one complete lobby lifecycle';

COMMENT ON COLUMN "game"."lobby_access_token"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."lobby_membership" IS 'Migration adds a partial unique index on player_id WHERE left_at IS NULL. Runtime presence and reconnect reservation remain in Nakama/Redis.';

COMMENT ON COLUMN "game"."lobby_membership"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."lobby_host_assignment" IS 'Migration adds a partial unique index on lobby_id WHERE ended_at IS NULL.';

COMMENT ON COLUMN "game"."lobby_host_assignment"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."game_round" IS 'Completed round rows and detailed result children are immutable through service policy and migration triggers. Later public corrections or invalidations append round_result_revision rows and never edit this result.';

COMMENT ON COLUMN "game"."game_round"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."round_participant" IS 'Inserted as terminal result data when a round completes; live participant roles and state remain in the authoritative match runtime.';

COMMENT ON COLUMN "game"."round_participant"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "game"."round_discovery"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "game"."round_disguise_snapshot"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."round_like" IS 'Composite FK guarantees target participated in the same round; service verifies target was a Hider and voter was eligible.';

COMMENT ON COLUMN "game"."round_like"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."round_result_revision" IS 'Append-only local result history. previous_revision_id is unique to keep the chain linear; a migration trigger also requires the previous row to belong to the same round and revision_number to advance by one. The initial revision is committed with the terminal detailed result and matches game_round versions/hash.';

COMMENT ON COLUMN "game"."round_result_revision"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."match_publication_request" IS 'The initial request is inserted in the same database transaction as the completed round, detailed rows, and initial result revision. Migration enforces type agreement with the revision and one noncancelled initial request per round.';

COMMENT ON COLUMN "game"."match_publication_request"."id" IS 'Application-generated UUIDv7; stable publication request';

COMMENT ON TABLE "game"."match_publication_outbox" IS 'Operational outbox, not the HAF projection. canonical_payload is the exact immutable application payload used across retries; parsed_payload is validated query data. Initial events carry a stable batch UUID and period; correction/invalidation events are single-result events and carry their original-batch lineage inside the event payload/change projection. Initial batching defaults to five minutes, 20 results, or 6 KiB, whichever is reached first; only production tuning is open. A retry may rebuild transaction headers but not logical IDs or payload bytes/hash.';

COMMENT ON COLUMN "game"."match_publication_outbox"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "game"."match_publication_outbox"."event_uuid" IS 'Stable protocol UUIDv7 across retries';

COMMENT ON COLUMN "game"."match_publication_outbox"."batch_uuid" IS 'Stable logical batch UUIDv7 across retries; initial batches only';

COMMENT ON TABLE "game"."match_publication_item" IS 'Links durable requests to one immutable payload. Migrations verify request/revision/round/type consistency, enforce one item for correction/invalidation events, and enforce item count/positions against outbox.result_count.';

COMMENT ON COLUMN "game"."match_publication_item"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "game"."player_mode_stat" IS 'Rebuildable cache; round history remains authoritative.';

COMMENT ON COLUMN "game"."achievement_definition"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "game"."player_achievement"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "content"."map"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "content"."map_version" IS 'After submission, version identity, manifest, package, and asset content are immutable; controlled review/status timestamps may advance. Package location/hash/size are stored once in map_asset(kind=package).';

COMMENT ON COLUMN "content"."map_version"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "content"."map_lifecycle_event" IS 'Append-only lifecycle history. Suspension/removal requires a creator-facing reason through service validation; actor may be null for an automated system transition.';

COMMENT ON COLUMN "content"."map_lifecycle_event"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "content"."map_asset" IS 'Migration adds a partial unique index enforcing one package asset per map version.';

COMMENT ON COLUMN "content"."map_asset"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "content"."map_review" IS 'Append-only review history. Authorization is defined by the separate roles and permissions design.';

COMMENT ON COLUMN "content"."map_review"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "content"."tag"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "content"."map_distribution"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "content"."map_showcase" IS 'Hive projection is authoritative for published post/vote data. Migration may add a partial unique index for one active showcase per map version.';

COMMENT ON COLUMN "content"."map_showcase"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."collectible_definition"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."collectible_asset"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "commerce"."collectible_instance" IS 'Hive event history is authoritative. Owner is immutable; collectibles and badges are non-transferable.';

COMMENT ON COLUMN "commerce"."collectible_instance"."id" IS 'Matches on-chain collectible UUIDv7';

COMMENT ON TABLE "commerce"."player_loadout" IS 'Migrations add partial unique indexes for one active row per player/slot and one active use per collectible. Service validates finalized ownership and slot compatibility.';

COMMENT ON COLUMN "commerce"."player_loadout"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."shop_offer"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."shop_offer_price"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."payment_transaction"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "commerce"."purchase"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "tournament"."tournament"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "tournament"."tournament_entry"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "tournament"."prize_rule"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "tournament"."tournament_match"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "tournament"."entry_score" IS 'Rebuildable cache; tournament matches and game rounds remain authoritative.';

COMMENT ON COLUMN "tournament"."payout"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."block_checkpoint" IS 'Retains reversible and replaced branch evidence, including blocks with no relevant operations. Migration adds one non-reverted checkpoint per source/height and prevents reverting an irreversible checkpoint.';

COMMENT ON COLUMN "hive_projection"."block_checkpoint"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."operation" IS 'Raw fork-aware operation evidence. Structurally malformed, unsupported, or unauthorized application operations remain here with a rejection reason and do not require a typed projection row.';

COMMENT ON COLUMN "hive_projection"."operation"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "hive_projection"."operation"."source_operation_id" IS 'Stable HAF/HAfAH operation identity, including virtual operations';

COMMENT ON TABLE "hive_projection"."match_event" IS 'Normalized HAF-derived event root. Initial batch events carry batch/period fields; correction and invalidation lineage is stored in match_result_change. Full validated payload remains on operation.payload. Projector state follows the referenced operation through inclusion, fork rollback, replay, and irreversibility; only allow-listed publisher events are accepted.';

COMMENT ON COLUMN "hive_projection"."match_event"."event_uuid" IS 'Stable protocol UUIDv7';

COMMENT ON COLUMN "hive_projection"."match_event"."batch_uuid" IS 'Stable logical batch UUIDv7; initial batches only';

COMMENT ON TABLE "hive_projection"."match_result" IS 'Integrity/join cache of an accepted initial Hive summary. Detailed participants, discoveries, and likes remain authoritative in game tables. One accepted initial result per round is enforced; current_event_uuid advances linearly only under projector rules, while the original event remains queryable.';

COMMENT ON COLUMN "hive_projection"."match_result"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."match_result_change" IS 'Append-only correction/invalidation projection. The unique supersedes edge prevents branching; projector triggers require original_event_uuid to be the initial batch and event_uuid to have the matching event type. Replacement public summary detail remains in the validated operation payload.';

COMMENT ON COLUMN "hive_projection"."match_result_change"."event_uuid" IS 'Correction/invalidation protocol UUIDv7';

COMMENT ON TABLE "hive_projection"."collectible_event" IS 'Raw chain projection remains auditable even when validation fails. Only accepted allow-listed issuer events update domain ownership.';

COMMENT ON TABLE "hive_projection"."asset_transfer" IS 'Native HIVE/HBD finality comes from HAF/LIB. AFIT also requires successful Hive-Engine contract execution.';

COMMENT ON COLUMN "hive_projection"."asset_transfer"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "hive_projection"."community_post"."id" IS 'Application-generated UUIDv7';

COMMENT ON COLUMN "hive_projection"."community_vote"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."transaction_intent" IS 'Separates authenticated player intent from its Hive signer and from official service operations. Contains no private keys, raw Google tokens, or wallet/service secrets. Custodial signing requires a current allow-listed intent and eligible session; canonical hash is intentionally not globally unique.';

COMMENT ON COLUMN "hive_projection"."transaction_intent"."id" IS 'Application-generated UUIDv7';

COMMENT ON TABLE "hive_projection"."rc_delegation" IS 'RC is max_rc capacity, not HIVE, HP, or content-vote weight. Initial capacity is supplied by the approved signup sponsor and projected from observed Hive evidence; a separate platform rc_support role may grant later general support. Grant/reclaim evidence uses posting-authority custom_json application id rc with a delegate_rc payload. Migration adds partial active uniqueness by delegator, recipient, and purpose; initial provisioning may exist before player creation and is linked later.';

COMMENT ON COLUMN "hive_projection"."rc_delegation"."id" IS 'Application-generated UUIDv7';

ALTER TABLE "identity"."player_profile" ADD CONSTRAINT "fk_player_profile_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."external_identity" ADD CONSTRAINT "fk_external_identity_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_provisioning" ADD CONSTRAINT "fk_provisioning_external_identity" FOREIGN KEY ("external_identity_id") REFERENCES "identity"."external_identity" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_provisioning" ADD CONSTRAINT "fk_provisioning_player" FOREIGN KEY ("resulting_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_provisioning" ADD CONSTRAINT "fk_provisioning_creation_operation" FOREIGN KEY ("account_creation_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_provisioning" ADD CONSTRAINT "fk_provisioning_rc_delegation" FOREIGN KEY ("initial_rc_delegation_id") REFERENCES "hive_projection"."rc_delegation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."custody_key_reference" ADD CONSTRAINT "fk_custody_key_provisioning" FOREIGN KEY ("provisioning_id") REFERENCES "identity"."hive_account_provisioning" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."custody_key_reference" ADD CONSTRAINT "fk_custody_key_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_claim" ADD CONSTRAINT "fk_hive_account_claim_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_claim" ADD CONSTRAINT "fk_hive_account_claim_intent" FOREIGN KEY ("transaction_intent_id") REFERENCES "hive_projection"."transaction_intent" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_claim" ADD CONSTRAINT "fk_claim_change_recovery_op" FOREIGN KEY ("change_recovery_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_claim" ADD CONSTRAINT "fk_claim_account_update_op" FOREIGN KEY ("account_update_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."hive_account_claim" ADD CONSTRAINT "fk_claim_changed_recovery_op" FOREIGN KEY ("changed_recovery_virtual_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."public_record_disclosure_acknowledgment" ADD CONSTRAINT "fk_disclosure_ack_disclosure" FOREIGN KEY ("disclosure_version") REFERENCES "identity"."public_record_disclosure" ("disclosure_version") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."public_record_disclosure_acknowledgment" ADD CONSTRAINT "fk_disclosure_ack_external" FOREIGN KEY ("external_identity_id") REFERENCES "identity"."external_identity" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."public_record_disclosure_acknowledgment" ADD CONSTRAINT "fk_disclosure_ack_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."auth_session" ADD CONSTRAINT "fk_auth_session_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."auth_session" ADD CONSTRAINT "fk_auth_session_external" FOREIGN KEY ("external_identity_id") REFERENCES "identity"."external_identity" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."player_preference" ADD CONSTRAINT "fk_player_preference_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."player_platform_setting" ADD CONSTRAINT "fk_platform_setting_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."player_appearance" ADD CONSTRAINT "fk_player_appearance_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_approval" ADD CONSTRAINT "fk_platform_role_approval_target" FOREIGN KEY ("target_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_approval" ADD CONSTRAINT "fk_platform_role_approval_requester" FOREIGN KEY ("requested_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_approval" ADD CONSTRAINT "fk_platform_role_approval_approver" FOREIGN KEY ("approved_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_granter" FOREIGN KEY ("granted_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_approval" FOREIGN KEY ("approval_id") REFERENCES "identity"."platform_role_approval" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_grant_audit" FOREIGN KEY ("grant_audit_event_id") REFERENCES "identity"."authorization_audit_event" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_revoker" FOREIGN KEY ("revoked_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."platform_role_assignment" ADD CONSTRAINT "fk_platform_role_assignment_revocation_audit" FOREIGN KEY ("revocation_audit_event_id") REFERENCES "identity"."authorization_audit_event" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."authorization_audit_event" ADD CONSTRAINT "fk_authorization_audit_actor" FOREIGN KEY ("actor_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "identity"."authorization_audit_event" ADD CONSTRAINT "fk_authorization_audit_subject" FOREIGN KEY ("subject_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."friend_request" ADD CONSTRAINT "fk_friend_request_requester" FOREIGN KEY ("requester_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."friend_request" ADD CONSTRAINT "fk_friend_request_recipient" FOREIGN KEY ("recipient_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."friendship" ADD CONSTRAINT "fk_friendship_low" FOREIGN KEY ("player_low_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."friendship" ADD CONSTRAINT "fk_friendship_high" FOREIGN KEY ("player_high_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."friendship" ADD CONSTRAINT "fk_friendship_request" FOREIGN KEY ("source_request_id") REFERENCES "social"."friend_request" ("id") ON DELETE SET NULL ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."player_block" ADD CONSTRAINT "fk_block_blocker" FOREIGN KEY ("blocker_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."player_block" ADD CONSTRAINT "fk_block_blocked" FOREIGN KEY ("blocked_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."lobby_invitation" ADD CONSTRAINT "fk_lobby_invitation_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."lobby_invitation" ADD CONSTRAINT "fk_lobby_invitation_inviter" FOREIGN KEY ("inviter_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."lobby_invitation" ADD CONSTRAINT "fk_lobby_invitation_invitee" FOREIGN KEY ("invitee_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "social"."notification" ADD CONSTRAINT "fk_notification_recipient" FOREIGN KEY ("recipient_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby" ADD CONSTRAINT "fk_lobby_current_host" FOREIGN KEY ("current_host_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_access_token" ADD CONSTRAINT "fk_lobby_token_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_access_token" ADD CONSTRAINT "fk_lobby_token_creator" FOREIGN KEY ("created_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_membership" ADD CONSTRAINT "fk_lobby_membership_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_membership" ADD CONSTRAINT "fk_lobby_membership_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_host_assignment" ADD CONSTRAINT "fk_host_assignment_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_host_assignment" ADD CONSTRAINT "fk_host_assignment_player" FOREIGN KEY ("host_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_configuration" ADD CONSTRAINT "fk_lobby_configuration_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."lobby_configuration" ADD CONSTRAINT "fk_lobby_configuration_map" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."game_round" ADD CONSTRAINT "fk_game_round_lobby" FOREIGN KEY ("lobby_id") REFERENCES "game"."lobby" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."game_round" ADD CONSTRAINT "fk_game_round_map" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_participant" ADD CONSTRAINT "fk_round_participant_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_participant" ADD CONSTRAINT "fk_round_participant_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_discovery" ADD CONSTRAINT "fk_round_discovery_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_discovery" ADD CONSTRAINT "fk_round_discovery_hunter" FOREIGN KEY ("round_id", "hunter_player_id") REFERENCES "game"."round_participant" ("round_id", "player_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_discovery" ADD CONSTRAINT "fk_round_discovery_hider" FOREIGN KEY ("round_id", "hider_player_id") REFERENCES "game"."round_participant" ("round_id", "player_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_disguise_snapshot" ADD CONSTRAINT "fk_disguise_participant" FOREIGN KEY ("round_participant_id") REFERENCES "game"."round_participant" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_like" ADD CONSTRAINT "fk_round_like_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_like" ADD CONSTRAINT "fk_round_like_voter" FOREIGN KEY ("voter_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_like" ADD CONSTRAINT "fk_round_like_target" FOREIGN KEY ("round_id", "target_hider_player_id") REFERENCES "game"."round_participant" ("round_id", "player_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_result_revision" ADD CONSTRAINT "fk_round_result_revision_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."round_result_revision" ADD CONSTRAINT "fk_round_result_revision_previous" FOREIGN KEY ("previous_revision_id") REFERENCES "game"."round_result_revision" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_request" ADD CONSTRAINT "fk_match_publication_request_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_request" ADD CONSTRAINT "fk_match_publication_request_revision" FOREIGN KEY ("result_revision_id") REFERENCES "game"."round_result_revision" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_outbox" ADD CONSTRAINT "fk_match_outbox_operation" FOREIGN KEY ("operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_outbox" FOREIGN KEY ("outbox_id") REFERENCES "game"."match_publication_outbox" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_request" FOREIGN KEY ("publication_request_id") REFERENCES "game"."match_publication_request" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_round" FOREIGN KEY ("round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."match_publication_item" ADD CONSTRAINT "fk_match_publication_item_revision" FOREIGN KEY ("result_revision_id", "round_id") REFERENCES "game"."round_result_revision" ("id", "round_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."player_mode_stat" ADD CONSTRAINT "fk_player_mode_stat_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."achievement_definition" ADD CONSTRAINT "fk_achievement_badge_definition" FOREIGN KEY ("badge_collectible_definition_id") REFERENCES "commerce"."collectible_definition" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."player_achievement" ADD CONSTRAINT "fk_player_achievement_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."player_achievement" ADD CONSTRAINT "fk_player_achievement_definition" FOREIGN KEY ("achievement_definition_id") REFERENCES "game"."achievement_definition" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "game"."player_achievement" ADD CONSTRAINT "fk_player_achievement_badge" FOREIGN KEY ("badge_collectible_instance_id") REFERENCES "commerce"."collectible_instance" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map" ADD CONSTRAINT "fk_map_creator" FOREIGN KEY ("creator_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_version" ADD CONSTRAINT "fk_map_version_map" FOREIGN KEY ("map_id") REFERENCES "content"."map" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_lifecycle_event" ADD CONSTRAINT "fk_map_lifecycle_event_map" FOREIGN KEY ("map_id") REFERENCES "content"."map" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_lifecycle_event" ADD CONSTRAINT "fk_map_lifecycle_event_version" FOREIGN KEY ("map_version_id", "map_id") REFERENCES "content"."map_version" ("id", "map_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_lifecycle_event" ADD CONSTRAINT "fk_map_lifecycle_event_actor" FOREIGN KEY ("changed_by_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_asset" ADD CONSTRAINT "fk_map_asset_version" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_review" ADD CONSTRAINT "fk_map_review_version" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_review" ADD CONSTRAINT "fk_map_review_reviewer" FOREIGN KEY ("reviewer_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_tag" ADD CONSTRAINT "fk_map_tag_map" FOREIGN KEY ("map_id") REFERENCES "content"."map" ("id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_tag" ADD CONSTRAINT "fk_map_tag_tag" FOREIGN KEY ("tag_id") REFERENCES "content"."tag" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_distribution" ADD CONSTRAINT "fk_map_distribution_version" FOREIGN KEY ("map_version_id") REFERENCES "content"."map_version" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_showcase" ADD CONSTRAINT "fk_map_showcase_map" FOREIGN KEY ("map_id") REFERENCES "content"."map" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_showcase" ADD CONSTRAINT "fk_map_showcase_version" FOREIGN KEY ("map_version_id", "map_id") REFERENCES "content"."map_version" ("id", "map_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_showcase" ADD CONSTRAINT "fk_map_showcase_creator" FOREIGN KEY ("creator_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content"."map_showcase" ADD CONSTRAINT "fk_map_showcase_post" FOREIGN KEY ("community_post_id") REFERENCES "hive_projection"."community_post" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_asset" ADD CONSTRAINT "fk_collectible_asset_definition" FOREIGN KEY ("collectible_definition_id") REFERENCES "commerce"."collectible_definition" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_instance" ADD CONSTRAINT "fk_collectible_instance_definition" FOREIGN KEY ("collectible_definition_id") REFERENCES "commerce"."collectible_definition" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_instance" ADD CONSTRAINT "fk_collectible_instance_owner" FOREIGN KEY ("owner_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_instance" ADD CONSTRAINT "fk_collectible_instance_issued_event" FOREIGN KEY ("issued_event_id", "id", "collectible_definition_id") REFERENCES "hive_projection"."collectible_event" ("event_id", "collectible_id", "collectible_definition_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_instance" ADD CONSTRAINT "fk_collectible_instance_revoked_event" FOREIGN KEY ("revoked_event_id", "id", "collectible_definition_id") REFERENCES "hive_projection"."collectible_event" ("event_id", "collectible_id", "collectible_definition_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."collectible_instance" ADD CONSTRAINT "fk_collectible_instance_payment" FOREIGN KEY ("payment_transaction_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."player_loadout" ADD CONSTRAINT "fk_loadout_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."player_loadout" ADD CONSTRAINT "fk_loadout_collectible" FOREIGN KEY ("collectible_instance_id") REFERENCES "commerce"."collectible_instance" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."shop_offer" ADD CONSTRAINT "fk_shop_offer_definition" FOREIGN KEY ("collectible_definition_id") REFERENCES "commerce"."collectible_definition" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."shop_offer_price" ADD CONSTRAINT "fk_offer_price_offer" FOREIGN KEY ("shop_offer_id") REFERENCES "commerce"."shop_offer" ("id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."payment_transaction" ADD CONSTRAINT "fk_payment_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."payment_transaction" ADD CONSTRAINT "fk_payment_intent" FOREIGN KEY ("transaction_intent_id") REFERENCES "hive_projection"."transaction_intent" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."purchase" ADD CONSTRAINT "fk_purchase_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."purchase" ADD CONSTRAINT "fk_purchase_offer" FOREIGN KEY ("shop_offer_id") REFERENCES "commerce"."shop_offer" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."purchase" ADD CONSTRAINT "fk_purchase_price_offer" FOREIGN KEY ("shop_offer_price_id", "shop_offer_id") REFERENCES "commerce"."shop_offer_price" ("id", "shop_offer_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."purchase" ADD CONSTRAINT "fk_purchase_payment" FOREIGN KEY ("payment_transaction_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "commerce"."purchase" ADD CONSTRAINT "fk_purchase_collectible" FOREIGN KEY ("collectible_instance_id") REFERENCES "commerce"."collectible_instance" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament" ADD CONSTRAINT "fk_tournament_organizer" FOREIGN KEY ("organizer_player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_entry" ADD CONSTRAINT "fk_tournament_entry_tournament" FOREIGN KEY ("tournament_id") REFERENCES "tournament"."tournament" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_entry" ADD CONSTRAINT "fk_tournament_entry_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_entry" ADD CONSTRAINT "fk_tournament_entry_payment" FOREIGN KEY ("entry_payment_transaction_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."prize_rule" ADD CONSTRAINT "fk_prize_rule_tournament" FOREIGN KEY ("tournament_id") REFERENCES "tournament"."tournament" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_match" ADD CONSTRAINT "fk_tournament_match_tournament" FOREIGN KEY ("tournament_id") REFERENCES "tournament"."tournament" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_match" ADD CONSTRAINT "fk_tournament_match_winner" FOREIGN KEY ("winning_entry_id", "tournament_id") REFERENCES "tournament"."tournament_entry" ("id", "tournament_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."tournament_match" ADD CONSTRAINT "fk_tournament_match_winner_participation" FOREIGN KEY ("id", "winning_entry_id") REFERENCES "tournament"."match_entry" ("tournament_match_id", "tournament_entry_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."match_entry" ADD CONSTRAINT "fk_match_entry_match" FOREIGN KEY ("tournament_match_id", "tournament_id") REFERENCES "tournament"."tournament_match" ("id", "tournament_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."match_entry" ADD CONSTRAINT "fk_match_entry_entry" FOREIGN KEY ("tournament_entry_id", "tournament_id") REFERENCES "tournament"."tournament_entry" ("id", "tournament_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."match_game_round" ADD CONSTRAINT "fk_match_round_match" FOREIGN KEY ("tournament_match_id") REFERENCES "tournament"."tournament_match" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."match_game_round" ADD CONSTRAINT "fk_match_round_round" FOREIGN KEY ("game_round_id") REFERENCES "game"."game_round" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."entry_score" ADD CONSTRAINT "fk_entry_score_entry" FOREIGN KEY ("tournament_entry_id") REFERENCES "tournament"."tournament_entry" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."payout" ADD CONSTRAINT "fk_payout_tournament" FOREIGN KEY ("tournament_id") REFERENCES "tournament"."tournament" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."payout" ADD CONSTRAINT "fk_payout_entry" FOREIGN KEY ("tournament_entry_id", "tournament_id") REFERENCES "tournament"."tournament_entry" ("id", "tournament_id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "tournament"."payout" ADD CONSTRAINT "fk_payout_payment" FOREIGN KEY ("payment_transaction_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."operation" ADD CONSTRAINT "fk_hive_operation_checkpoint" FOREIGN KEY ("checkpoint_id") REFERENCES "hive_projection"."block_checkpoint" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

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

ALTER TABLE "hive_projection"."collectible_event" ADD CONSTRAINT "fk_collectible_event_operation" FOREIGN KEY ("operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."collectible_event" ADD CONSTRAINT "fk_collectible_event_payment" FOREIGN KEY ("payment_transaction_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."asset_transfer" ADD CONSTRAINT "fk_asset_transfer_operation" FOREIGN KEY ("operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."asset_transfer" ADD CONSTRAINT "fk_asset_transfer_payment" FOREIGN KEY ("consumed_by_payment_id") REFERENCES "commerce"."payment_transaction" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."community_post" ADD CONSTRAINT "fk_community_post_created_op" FOREIGN KEY ("created_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."community_post" ADD CONSTRAINT "fk_community_post_latest_op" FOREIGN KEY ("latest_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."community_vote" ADD CONSTRAINT "fk_community_vote_post" FOREIGN KEY ("community_post_id") REFERENCES "hive_projection"."community_post" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."community_vote" ADD CONSTRAINT "fk_community_vote_operation" FOREIGN KEY ("latest_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."transaction_intent" ADD CONSTRAINT "fk_transaction_intent_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."transaction_intent" ADD CONSTRAINT "fk_transaction_intent_session" FOREIGN KEY ("auth_session_id") REFERENCES "identity"."auth_session" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."transaction_intent" ADD CONSTRAINT "fk_transaction_intent_custody_key" FOREIGN KEY ("custody_key_reference_id") REFERENCES "identity"."custody_key_reference" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."rc_delegation" ADD CONSTRAINT "fk_rc_delegation_player" FOREIGN KEY ("player_id") REFERENCES "identity"."player" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."rc_delegation" ADD CONSTRAINT "fk_rc_delegation_provisioning" FOREIGN KEY ("provisioning_id") REFERENCES "identity"."hive_account_provisioning" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."rc_delegation" ADD CONSTRAINT "fk_rc_delegation_grant" FOREIGN KEY ("grant_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "hive_projection"."rc_delegation" ADD CONSTRAINT "fk_rc_delegation_reclaim" FOREIGN KEY ("reclaim_operation_id") REFERENCES "hive_projection"."operation" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
