\echo 'terminal round, revision chain, host, and map immutability'

CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(statement text, expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  caught_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS caught_state = RETURNED_SQLSTATE;
    IF caught_state <> expected_state THEN
      RAISE EXCEPTION 'expected SQLSTATE %, got % for %', expected_state, caught_state, statement;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected SQLSTATE %, statement succeeded: %', expected_state, statement;
END;
$$;

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
  ('01900000-0000-7000-8000-000000000501', 'hunter-one', 'external_self_custodial'),
  ('01900000-0000-7000-8000-000000000502', 'hider-one', 'external_self_custodial');

INSERT INTO content.map (
  id, origin, creator_player_id, slug, title, description, lifecycle
)
VALUES (
  '01900000-0000-7000-8000-000000000510',
  'community',
  '01900000-0000-7000-8000-000000000501',
  'test-map',
  'Test Map',
  'Constraint-test map',
  'draft'
);

INSERT INTO content.map_version (
  id, map_id, version_number, manifest, status,
  license_declaration_version, license_accepted_at, created_at, updated_at
)
VALUES (
  '01900000-0000-7000-8000-000000000511',
  '01900000-0000-7000-8000-000000000510',
  '1.0.0',
  '{"format":1}',
  'draft',
  'license-1',
  '2026-07-16T11:00:00Z',
  '2026-07-16T10:00:00Z',
  '2026-07-16T10:00:00Z'
);

INSERT INTO content.map_asset (
  id, map_version_id, kind, object_storage_key, media_type, size_bytes, sha256
)
VALUES (
  '01900000-0000-7000-8000-000000000512',
  '01900000-0000-7000-8000-000000000511',
  'package',
  'maps/test-map/1.0.0/package.zip',
  'application/zip',
  1,
  repeat('d', 64)
);

INSERT INTO game.lobby (
  id, name, current_host_player_id, visibility, max_players,
  region_code, created_at
)
VALUES (
  '01900000-0000-7000-8000-000000000520',
  'Terminal test',
  '01900000-0000-7000-8000-000000000501',
  'public',
  10,
  'eu-test',
  '2026-07-16T12:00:00Z'
);

INSERT INTO game.lobby_membership (
  id, lobby_id, player_id, join_source, joined_at
)
VALUES
  (
    '01900000-0000-7000-8000-000000000521',
    '01900000-0000-7000-8000-000000000520',
    '01900000-0000-7000-8000-000000000501',
    'server_browser',
    '2026-07-16T12:01:00Z'
  ),
  (
    '01900000-0000-7000-8000-000000000522',
    '01900000-0000-7000-8000-000000000520',
    '01900000-0000-7000-8000-000000000502',
    'server_browser',
    '2026-07-16T12:02:00Z'
  );

INSERT INTO game.lobby_host_assignment (
  id, lobby_id, host_player_id, reason, started_at
)
VALUES (
  '01900000-0000-7000-8000-000000000523',
  '01900000-0000-7000-8000-000000000520',
  '01900000-0000-7000-8000-000000000501',
  'creator',
  '2026-07-16T12:01:00Z'
);

INSERT INTO game.game_round (
  id, lobby_id, sequence_number, mode, map_version_id, hunter_count,
  hiding_duration_seconds, hunting_duration_seconds, taunt_enabled,
  shell_limit, reload_duration_ms, auto_start_enabled, auto_start_threshold,
  game_server_build_version, protocol_version, status, result_schema_version,
  scoring_rule_version, canonical_result_sha256, started_at
)
VALUES (
  '01900000-0000-7000-8000-000000000530',
  '01900000-0000-7000-8000-000000000520',
  1,
  'casual',
  '01900000-0000-7000-8000-000000000511',
  1,
  60,
  180,
  false,
  8,
  1000,
  true,
  2,
  'server-test-1',
  'match-1',
  'answer_check',
  'match-result-1',
  'scoring-1',
  encode(digest(convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":1}', 'UTF8'), 'sha256'), 'hex'),
  '2026-07-16T13:00:00Z'
);

INSERT INTO game.round_participant (
  id, round_id, player_id, initial_role, final_role, character_form,
  size_preset, outcome, final_score
)
VALUES
  (
    '01900000-0000-7000-8000-000000000531',
    '01900000-0000-7000-8000-000000000530',
    '01900000-0000-7000-8000-000000000501',
    'hunter', 'hunter', 'humanoid', 'x1_0', 'hunter_win', 1000.0000
  ),
  (
    '01900000-0000-7000-8000-000000000532',
    '01900000-0000-7000-8000-000000000530',
    '01900000-0000-7000-8000-000000000502',
    'hider', 'hider', 'humanoid', 'x1_0', 'hider_found', 500.0000
  );

INSERT INTO game.round_result_revision (
  id, round_id, revision_number, revision_type, result_schema_version,
  scoring_rule_version, canonical_complete_result_sha256,
  canonical_complete_result
)
VALUES (
  '01900000-0000-7000-8000-000000000533',
  '01900000-0000-7000-8000-000000000530',
  1,
  'initial',
  'match-result-1',
  'scoring-1',
  encode(digest(convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":1}', 'UTF8'), 'sha256'), 'hex'),
  convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":1}', 'UTF8')
);

UPDATE game.game_round
   SET status = 'completed',
       winning_side = 'hunters',
       ended_at = '2026-07-16T14:00:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000530';

COMMIT;

SELECT pg_temp.assert_true(
  (
    SELECT convert_from(canonical_complete_result, 'UTF8') =
             '{"round":"01900000-0000-7000-8000-000000000530","revision":1}'
       AND canonical_complete_result_sha256 =
             encode(digest(canonical_complete_result, 'sha256'), 'hex')
      FROM game.round_result_revision
     WHERE id = '01900000-0000-7000-8000-000000000533'
  ),
  'the exact canonical terminal result bytes are durable and hash-bound'
);

INSERT INTO game.lobby (
  id, name, current_host_player_id, visibility, max_players,
  region_code, created_at, closed_at
)
VALUES (
  '01900000-0000-7000-8000-000000000524',
  'Closed host test',
  '01900000-0000-7000-8000-000000000501',
  'public',
  10,
  'eu-test',
  '2026-07-16T10:00:00Z',
  '2026-07-16T11:00:00Z'
);

BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.expect_sqlstate(
  $$UPDATE game.lobby_membership
       SET lobby_id = '01900000-0000-7000-8000-000000000524'
     WHERE id = '01900000-0000-7000-8000-000000000521'$$,
  '23514'
);
ROLLBACK;

SELECT pg_temp.expect_sqlstate(
  $$UPDATE game.game_round
       SET winning_side = 'hiders'
     WHERE id = '01900000-0000-7000-8000-000000000530'$$,
  '55000'
);

INSERT INTO game.round_result_revision (
  id, round_id, revision_number, revision_type, previous_revision_id,
  result_schema_version, scoring_rule_version, canonical_complete_result_sha256,
  canonical_complete_result, reason_code
)
VALUES (
  '01900000-0000-7000-8000-000000000535',
  '01900000-0000-7000-8000-000000000530',
  2,
  'correction',
  '01900000-0000-7000-8000-000000000533',
  'match-result-1',
  'scoring-1',
  encode(digest(convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":2}', 'UTF8'), 'sha256'), 'hex'),
  convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":2}', 'UTF8'),
  'authoritative_result_correction'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO game.round_result_revision (
      id, round_id, revision_number, revision_type, previous_revision_id,
      result_schema_version, scoring_rule_version, canonical_complete_result_sha256,
      canonical_complete_result, reason_code
    ) VALUES (
      '01900000-0000-7000-8000-000000000543',
      '01900000-0000-7000-8000-000000000530',
      3, 'correction',
      '01900000-0000-7000-8000-000000000535',
      'match-result-1', 'scoring-1', repeat('0', 64),
      convert_to('{"round":"01900000-0000-7000-8000-000000000530","revision":3}', 'UTF8'),
      'invalid_hash'
    )$$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO game.round_result_revision (
      id, round_id, revision_number, revision_type, previous_revision_id,
      result_schema_version, scoring_rule_version, canonical_complete_result_sha256,
      canonical_complete_result, reason_code
    ) VALUES (
      '01900000-0000-7000-8000-000000000536',
      '01900000-0000-7000-8000-000000000530',
      2, 'correction',
      '01900000-0000-7000-8000-000000000533',
      'match-result-1', 'scoring-1',
      encode(digest(convert_to('{"branch":true}', 'UTF8'), 'sha256'), 'hex'),
      convert_to('{"branch":true}', 'UTF8'), 'invalid_branch'
    )$$,
  '23505'
);

UPDATE content.map_version
   SET status = 'submitted', submitted_at = '2026-07-16T15:00:00Z'
 WHERE id = '01900000-0000-7000-8000-000000000511';

SELECT pg_temp.expect_sqlstate(
  $$UPDATE content.map_version
       SET submitted_at = NULL
     WHERE id = '01900000-0000-7000-8000-000000000511'$$,
  '55000'
);

SELECT pg_temp.expect_sqlstate(
  $$UPDATE content.map_asset
       SET map_version_id = '01900000-0000-7000-8000-000000000599'
     WHERE id = '01900000-0000-7000-8000-000000000512'$$,
  '55000'
);

SELECT pg_temp.expect_sqlstate(
  $$UPDATE content.map_version
       SET manifest = '{"format":2}'
     WHERE id = '01900000-0000-7000-8000-000000000511'$$,
  '55000'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO content.map_review (
      id, map_version_id, reviewer_player_id, decision
    ) VALUES (
      '01900000-0000-7000-8000-000000000540',
      '01900000-0000-7000-8000-000000000511',
      '01900000-0000-7000-8000-000000000501',
      'under_review'
    )$$,
  '23514'
);
