-- migrate:up

-- Public WebGL visitors receive isolated, revocable guest identities. Guests
-- remain application-only and are never eligible for Hive signing or custody.
ALTER TYPE identity.authentication_method ADD VALUE IF NOT EXISTS 'guest';

ALTER TABLE identity.player
  ADD COLUMN is_guest boolean NOT NULL DEFAULT false;

ALTER TABLE identity.player
  ADD CONSTRAINT chk_player_guest_identity
  CHECK (
    NOT is_guest
    OR (
      hive_username ~ '^guest-[0-9a-f]{10}$'
      AND hive_control_state = 'authority_claimed_recovery_pending'
    )
  );

CREATE INDEX idx_player_guest_created
  ON identity.player (created_at)
  WHERE is_guest;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
