-- migrate:up

CREATE TABLE identity.hive_login_challenge (
  id uuid PRIMARY KEY NOT NULL,
  hive_username varchar(16) NOT NULL,
  platform identity.client_platform NOT NULL,
  device_session_id uuid NOT NULL,
  challenge_text text NOT NULL,
  challenge_sha256 char(64) UNIQUE NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT chk_hive_login_challenge_id_uuid_v7
    CHECK (public.hc_is_uuid_v7(id)),
  CONSTRAINT chk_hive_login_challenge_username_lower
    CHECK (hive_username = lower(hive_username)),
  CONSTRAINT chk_hive_login_challenge_expiry
    CHECK (expires_at > issued_at),
  CONSTRAINT chk_hive_login_challenge_consumed
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CONSTRAINT chk_hive_login_challenge_hash
    CHECK (
      encode(digest(convert_to(challenge_text, 'UTF8'), 'sha256'), 'hex') = challenge_sha256
    )
);

CREATE INDEX idx_hive_login_challenge_expiry
  ON identity.hive_login_challenge (expires_at, consumed_at);

COMMENT ON TABLE identity.hive_login_challenge IS
  'Single-use canonical direct-Hive login challenges. Text is public; random nonce and UUID prevent guessing, and atomic consumption prevents replay.';

GRANT SELECT, INSERT, UPDATE ON identity.hive_login_challenge TO hc_api;
GRANT UPDATE (player_id, player_linked_at)
  ON identity.public_record_disclosure_acknowledgment TO hc_provisioning;

INSERT INTO identity.public_record_disclosure (
  disclosure_version, content_sha256, effective_at
) VALUES (
  '2026-07-22',
  '64ae0b7b385c6f4c1287e25979c44fce05c51583f61f20c7bb7e31171d921cc3',
  '2026-07-22T00:00:00Z'
);

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
