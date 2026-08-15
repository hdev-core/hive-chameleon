-- migrate:up

CREATE TABLE game.round_live_checkpoint (
  round_id uuid PRIMARY KEY,
  format_version smallint NOT NULL,
  private_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_round_live_checkpoint_uuid_v7
    CHECK (public.hc_is_uuid_v7(round_id)),
  CONSTRAINT chk_round_live_checkpoint_format
    CHECK (format_version > 0),
  CONSTRAINT chk_round_live_checkpoint_object
    CHECK (jsonb_typeof(private_state) = 'object'),
  CONSTRAINT chk_round_live_checkpoint_time
    CHECK (updated_at >= created_at),
  CONSTRAINT fk_round_live_checkpoint_round
    FOREIGN KEY (round_id)
    REFERENCES game.game_round (id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

COMMENT ON TABLE game.round_live_checkpoint IS
  'Private Nakama-only checkpoint for an active authoritative round. It is deleted after terminal result commit and is never part of a client or public projection contract.';

REVOKE ALL ON game.round_live_checkpoint FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON game.round_live_checkpoint TO hc_nakama;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
