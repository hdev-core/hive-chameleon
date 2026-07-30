-- migrate:up

-- The publication worker builds the public summary from committed evidence. It cannot read
-- sessions, custody records, private audit data, or mutate gameplay rows.
GRANT USAGE ON SCHEMA identity, content, tournament TO hc_match_publisher;
GRANT SELECT ON
  identity.player,
  content.map,
  content.map_version,
  content.map_asset,
  game.round_participant,
  game.round_discovery,
  game.round_like,
  tournament.match_game_round,
  tournament.tournament_match
  TO hc_match_publisher;
GRANT UPDATE (updated_at)
  ON game.match_publication_request, game.match_publication_outbox
  TO hc_match_publisher;
GRANT UPDATE (updated_at)
  ON hive_projection.transaction_intent
  TO hc_match_publisher, hc_collectible_issuer;
GRANT EXECUTE ON FUNCTION public.digest(bytea, text) TO hc_match_publisher;

-- Only irreversible accepted collectible events may advance the ownership cache. The projector
-- cannot edit definition, player, purchase, payment, or loadout data.
GRANT INSERT (
  id,
  collectible_definition_id,
  owner_player_id,
  issuer_hive_account,
  issuance_reason,
  metadata_uri,
  metadata_sha256,
  state,
  issued_event_id,
  issued_hive_transaction_id,
  issued_hive_block_number,
  irreversible_at,
  payment_transaction_id
) ON commerce.collectible_instance TO hc_projector;
GRANT UPDATE (state, revoked_event_id, revoked_at)
  ON commerce.collectible_instance TO hc_projector;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
