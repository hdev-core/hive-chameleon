-- migrate:up

ALTER TABLE game.lobby_membership
  ADD COLUMN hunter_nominated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN game.lobby_membership.hunter_nominated IS
  'Durable pre-round Hunter volunteer toggle. Nakama rehydrates it after a match-handler restart and clears it transactionally when the round starts.';

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
