\echo 'authenticated reconnect discovery without private checkpoint disclosure'

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

BEGIN;

INSERT INTO identity.player (id, hive_username, hive_control_state)
VALUES
  ('01900000-0000-7000-8000-000000000601', 'reconnect-one', 'external_self_custodial'),
  ('01900000-0000-7000-8000-000000000602', 'reconnect-two', 'external_self_custodial'),
  ('01900000-0000-7000-8000-000000000603', 'reconnect-other', 'external_self_custodial');

INSERT INTO game.lobby (
  id, name, current_host_player_id, visibility, max_players,
  region_code, created_at
)
VALUES (
  '01900000-0000-7000-8000-000000000620',
  'Reconnect test',
  '01900000-0000-7000-8000-000000000601',
  'public',
  10,
  'eu-test',
  '2026-08-01T11:50:00Z'
);

INSERT INTO game.lobby_membership (
  id, lobby_id, player_id, join_source, joined_at
)
VALUES
  (
    '01900000-0000-7000-8000-000000000621',
    '01900000-0000-7000-8000-000000000620',
    '01900000-0000-7000-8000-000000000601',
    'server_browser',
    '2026-08-01T11:51:00Z'
  ),
  (
    '01900000-0000-7000-8000-000000000622',
    '01900000-0000-7000-8000-000000000620',
    '01900000-0000-7000-8000-000000000602',
    'server_browser',
    '2026-08-01T11:52:00Z'
  );

INSERT INTO game.lobby_host_assignment (
  id, lobby_id, host_player_id, reason, started_at
)
VALUES (
  '01900000-0000-7000-8000-000000000623',
  '01900000-0000-7000-8000-000000000620',
  '01900000-0000-7000-8000-000000000601',
  'creator',
  '2026-08-01T11:51:00Z'
);

INSERT INTO game.game_round (
  id, lobby_id, sequence_number, mode, map_version_id, hunter_count,
  hiding_duration_seconds, hunting_duration_seconds, taunt_enabled,
  shell_limit, reload_duration_ms, auto_start_enabled, auto_start_threshold,
  game_server_build_version, protocol_version, status, result_schema_version,
  scoring_rule_version, started_at
)
SELECT
  '01900000-0000-7000-8000-000000000630',
  '01900000-0000-7000-8000-000000000620',
  1,
  'casual',
  version.id,
  1,
  60,
  180,
  false,
  6,
  2000,
  true,
  2,
  'hive-chameleon-m4-dev',
  'm4-v2',
  'hunting',
  'match-result-1',
  'scoring-1',
  '2026-08-01T11:55:00Z'
FROM content.map_version AS version
JOIN content.map AS map ON map.id = version.map_id
WHERE map.slug = 'prism-foundry'
  AND version.version_number = 'm4-4';

INSERT INTO game.round_live_checkpoint (
  round_id, format_version, private_state, created_at, updated_at
)
VALUES (
  '01900000-0000-7000-8000-000000000630',
  2,
  jsonb_build_object(
    'version', 2,
    'round_id', '01900000-0000-7000-8000-000000000630',
    'authoritative_round', jsonb_build_object(
      'Assignments', jsonb_build_object(
        '01900000-0000-7000-8000-000000000601', jsonb_build_object(
          'player_id', '01900000-0000-7000-8000-000000000601',
          'round_id', '01900000-0000-7000-8000-000000000630'
        ),
        '01900000-0000-7000-8000-000000000602', jsonb_build_object(
          'player_id', '01900000-0000-7000-8000-000000000602',
          'round_id', '01900000-0000-7000-8000-000000000630'
        )
      )
    ),
    'reconnect_reservations', jsonb_build_object(
      '01900000-0000-7000-8000-000000000601', jsonb_build_object(
        'PlayerID', '01900000-0000-7000-8000-000000000601',
        'RoundID', '01900000-0000-7000-8000-000000000630',
        'DisconnectedAt', '2026-08-01T12:00:00Z',
        'ExpiresAt', '2026-08-01T12:00:45Z'
      )
    )
  ),
  '2026-08-01T12:00:00Z',
  '2026-08-01T12:00:00Z'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'hc_api',
    'game.hc_find_reconnect_reservation(uuid,timestamp with time zone)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'hc_api',
    'game.round_live_checkpoint',
    'SELECT'
  ),
  'the API can execute only the descriptor function, not read private checkpoints'
);

SET LOCAL ROLE hc_api;

SELECT pg_temp.assert_true(
  (
    SELECT lobby_id = '01900000-0000-7000-8000-000000000620'
       AND expires_at = '2026-08-01T12:00:45Z'
       AND restoration_mode = 'same_role'
    FROM game.hc_find_reconnect_reservation(
      '01900000-0000-7000-8000-000000000601',
      '2026-08-01T12:00:10Z'
    )
  ),
  'an explicit reservation is discoverable only for its player'
);

SELECT pg_temp.assert_true(
  (
    SELECT expires_at = '2026-08-01T12:01:00Z'
    FROM game.hc_find_reconnect_reservation(
      '01900000-0000-7000-8000-000000000602',
      '2026-08-01T12:00:10Z'
    )
  ),
  'a recent checkpoint provides a bounded restart handoff without extending it'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM game.hc_find_reconnect_reservation(
      '01900000-0000-7000-8000-000000000603',
      '2026-08-01T12:00:10Z'
    )
  ),
  'a non-member cannot discover another player reservation'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM game.hc_find_reconnect_reservation(
      '01900000-0000-7000-8000-000000000601',
      '2026-08-01T12:00:45Z'
    )
  ),
  'the explicit reservation is unavailable at its exact expiry'
);

ROLLBACK;
