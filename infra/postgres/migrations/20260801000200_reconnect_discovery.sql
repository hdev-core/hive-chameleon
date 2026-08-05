-- migrate:up

CREATE OR REPLACE FUNCTION game.hc_find_reconnect_reservation(
  requested_player_id uuid,
  checked_at timestamptz
)
RETURNS TABLE (
  lobby_id uuid,
  expires_at timestamptz,
  restoration_mode text
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH candidate AS (
    SELECT
      round.lobby_id,
      round.id AS round_id,
      checkpoint.updated_at,
      checkpoint.private_state
        #> ARRAY['authoritative_round', 'Assignments'] AS assignments,
      checkpoint.private_state
        -> 'reconnect_reservations'
        -> requested_player_id::text AS reservation
    FROM game.round_live_checkpoint AS checkpoint
    JOIN game.game_round AS round
      ON round.id = checkpoint.round_id
    JOIN game.lobby AS lobby
      ON lobby.id = round.lobby_id
    JOIN game.lobby_membership AS membership
      ON membership.lobby_id = round.lobby_id
     AND membership.player_id = requested_player_id
     AND membership.left_at IS NULL
    WHERE checkpoint.format_version = 2
      AND checkpoint.private_state ->> 'version' = '2'
      AND checkpoint.private_state ->> 'round_id' = round.id::text
      AND round.status IN ('preparing', 'hiding', 'hunting', 'answer_check')
      AND lobby.closed_at IS NULL
  ), descriptor AS (
    SELECT
      candidate.lobby_id,
      candidate.round_id,
      CASE
        WHEN candidate.reservation IS NULL
          THEN candidate.updated_at + interval '60 seconds'
        ELSE (candidate.reservation ->> 'ExpiresAt')::timestamptz
      END AS expires_at
    FROM candidate
    WHERE jsonb_typeof(candidate.assignments) = 'object'
      AND candidate.assignments ? requested_player_id::text
      AND candidate.assignments
            -> requested_player_id::text
            ->> 'player_id' = requested_player_id::text
      AND candidate.assignments
            -> requested_player_id::text
            ->> 'round_id' = candidate.round_id::text
      AND (
        candidate.reservation IS NULL
        OR (
          jsonb_typeof(candidate.reservation) = 'object'
          AND candidate.reservation ->> 'PlayerID' = requested_player_id::text
          AND candidate.reservation ->> 'RoundID' = candidate.round_id::text
          AND candidate.reservation ? 'ExpiresAt'
        )
      )
  )
  SELECT
    descriptor.lobby_id,
    descriptor.expires_at,
    'same_role'::text AS restoration_mode
  FROM descriptor
  WHERE descriptor.expires_at > checked_at
  ORDER BY descriptor.expires_at
  LIMIT 1;
$$;

COMMENT ON FUNCTION game.hc_find_reconnect_reservation(uuid, timestamptz) IS
  'Returns only the authenticated player reconnect descriptor derived from the private Nakama checkpoint; checkpoint contents remain inaccessible to the API role.';

REVOKE ALL ON FUNCTION game.hc_find_reconnect_reservation(uuid, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION game.hc_find_reconnect_reservation(uuid, timestamptz)
  TO hc_api;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
