\echo 'accepted match projection and linear correction contract'

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, required_authority, application_id, payload, state,
  validation_state, validated_at
)
VALUES (
  '01900000-0000-7000-8000-000000000304',
  '01900000-0000-7000-8000-000000000204',
  '12345678901234567893', 'jkl012', 1, false, 101, '00000065cccc',
  '2026-07-16T12:05:00Z', 'custom_json', 'publisher', 'posting',
  'hive.chameleon',
  jsonb_build_object(
    'required_auths', '[]'::jsonb,
    'required_posting_auths', jsonb_build_array('publisher'),
    'id', 'hive.chameleon',
    'json', jsonb_build_object(
      'v', 1,
      'type', 'match_results_batch',
      'event_version', 1,
      'event_id', '01900000-0000-7000-8000-000000000404',
      'data', jsonb_build_object(
        'batch_id', '01900000-0000-7000-8000-000000000405',
        'period_start', '2026-07-16T12:00:00Z',
        'period_end', '2026-07-16T12:06:00Z',
        'publisher', 'publisher',
        'result_count', 1,
        'results', jsonb_build_array(
          jsonb_build_object(
            'round_id', '01900000-0000-7000-8000-000000000530',
            'result_schema', 'match-result-1',
            'scoring_rules', 'scoring-1',
            'map', jsonb_build_object(
              'version_id', '01900000-0000-7000-8000-000000000511',
              'content_sha256', repeat('d', 64)
            ),
            'server', jsonb_build_object('build', 'server-test-1', 'protocol', 'match-1'),
            'result_sha256', repeat('a', 64)
          )
        )
      )
    )::text
  ),
  'included', 'accepted', '2026-07-16T12:05:30Z'
);

INSERT INTO hive_projection.match_event (
  event_uuid, batch_uuid, operation_id, event_type, schema_version,
  event_contract_version, publication_period_start, publication_period_end,
  publisher_hive_account, result_count, operation_state, validation_state, included_at
)
VALUES (
  '01900000-0000-7000-8000-000000000404',
  '01900000-0000-7000-8000-000000000405',
  '01900000-0000-7000-8000-000000000304',
  'match_results_batch', 1, 'match-event-1',
  '2026-07-16T12:00:00Z', '2026-07-16T12:06:00Z',
  'publisher', 1, 'included', 'accepted', '2026-07-16T12:05:00Z'
);

INSERT INTO hive_projection.match_result (
  id, initial_event_uuid, result_position, round_id, result_schema_version,
  scoring_rule_version, map_version_id, map_content_sha256,
  server_build_version, match_protocol_version, public_result_sha256,
  current_state, current_event_uuid, matched_result_revision_id
)
VALUES (
  '01900000-0000-7000-8000-000000000600',
  '01900000-0000-7000-8000-000000000404',
  0,
  '01900000-0000-7000-8000-000000000530',
  'match-result-1',
  'scoring-1',
  '01900000-0000-7000-8000-000000000511',
  repeat('d', 64),
  'server-test-1',
  'match-1',
  repeat('a', 64),
  'current',
  '01900000-0000-7000-8000-000000000404',
  '01900000-0000-7000-8000-000000000533'
);

INSERT INTO hive_projection.operation (
  id, checkpoint_id, source_operation_id, transaction_id, operation_index,
  is_virtual, block_number, block_id, block_timestamp, operation_type,
  primary_account, required_authority, application_id, payload, state,
  validation_state, validated_at
)
VALUES (
  '01900000-0000-7000-8000-000000000305',
  '01900000-0000-7000-8000-000000000204',
  '12345678901234567894', 'mno345', 2, false, 101, '00000065cccc',
  '2026-07-16T12:05:00Z', 'custom_json', 'publisher', 'posting',
  'hive.chameleon',
  jsonb_build_object(
    'required_auths', '[]'::jsonb,
    'required_posting_auths', jsonb_build_array('publisher'),
    'id', 'hive.chameleon',
    'json', jsonb_build_object(
      'v', 1,
      'type', 'match_result_corrected',
      'event_version', 1,
      'event_id', '01900000-0000-7000-8000-000000000406',
      'data', jsonb_build_object(
        'round_id', '01900000-0000-7000-8000-000000000530',
        'original_batch_id', '01900000-0000-7000-8000-000000000405',
        'original_event_id', '01900000-0000-7000-8000-000000000404',
        'supersedes_event_id', '01900000-0000-7000-8000-000000000404',
        'publisher', 'publisher',
        'reason_code', 'authoritative_result_correction',
        'replacement_result', jsonb_build_object(
          'round_id', '01900000-0000-7000-8000-000000000530',
          'result_schema', 'match-result-1',
          'scoring_rules', 'scoring-1',
          'map', jsonb_build_object(
            'version_id', '01900000-0000-7000-8000-000000000511',
            'content_sha256', repeat('d', 64)
          ),
          'server', jsonb_build_object('build', 'server-test-1', 'protocol', 'match-1'),
          'result_sha256', repeat('b', 64)
        )
      )
    )::text
  ),
  'included', 'accepted', '2026-07-16T12:05:45Z'
);

INSERT INTO hive_projection.match_event (
  event_uuid, operation_id, event_type, schema_version, event_contract_version,
  publisher_hive_account, result_count, operation_state, validation_state, included_at
)
VALUES (
  '01900000-0000-7000-8000-000000000406',
  '01900000-0000-7000-8000-000000000305',
  'match_result_corrected', 1, 'match-event-1',
  'publisher', 1, 'included', 'accepted', '2026-07-16T12:05:00Z'
);

BEGIN;

INSERT INTO game.round_result_revision (
  id, round_id, revision_number, revision_type, previous_revision_id,
  result_schema_version, scoring_rule_version, canonical_complete_result_sha256,
  canonical_result_object_key, reason_code
)
VALUES (
  '01900000-0000-7000-8000-000000000536',
  '01900000-0000-7000-8000-000000000530',
  3,
  'correction',
  '01900000-0000-7000-8000-000000000535',
  'wrong-result-schema',
  'wrong-scoring-rules',
  repeat('c', 64),
  'round-results/rejected-correction-3.json',
  'authoritative_result_correction'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO hive_projection.match_result_change (
      event_uuid, projected_result_id, round_id, original_batch_uuid,
      original_event_uuid, supersedes_event_uuid, change_type, reason_code,
      replacement_result_revision_id, replacement_result_schema_version,
      replacement_scoring_rule_version, replacement_map_version_id,
      replacement_map_content_sha256, replacement_server_build_version,
      replacement_match_protocol_version, replacement_public_result_sha256
    )
    VALUES (
      '01900000-0000-7000-8000-000000000406',
      '01900000-0000-7000-8000-000000000600',
      '01900000-0000-7000-8000-000000000530',
      '01900000-0000-7000-8000-000000000405',
      '01900000-0000-7000-8000-000000000404',
      '01900000-0000-7000-8000-000000000404',
      'correction',
      'authoritative_result_correction',
      '01900000-0000-7000-8000-000000000536',
      'match-result-1',
      'scoring-1',
      '01900000-0000-7000-8000-000000000511',
      repeat('d', 64),
      'server-test-1',
      'match-1',
      repeat('b', 64)
    )$$,
  '23514'
);

ROLLBACK;

BEGIN;

INSERT INTO hive_projection.match_result_change (
  event_uuid, projected_result_id, round_id, original_batch_uuid,
  original_event_uuid, supersedes_event_uuid, change_type, reason_code,
  replacement_result_revision_id, replacement_result_schema_version,
  replacement_scoring_rule_version, replacement_map_version_id,
  replacement_map_content_sha256, replacement_server_build_version,
  replacement_match_protocol_version, replacement_public_result_sha256
)
VALUES (
  '01900000-0000-7000-8000-000000000406',
  '01900000-0000-7000-8000-000000000600',
  '01900000-0000-7000-8000-000000000530',
  '01900000-0000-7000-8000-000000000405',
  '01900000-0000-7000-8000-000000000404',
  '01900000-0000-7000-8000-000000000404',
  'correction',
  'authoritative_result_correction',
  '01900000-0000-7000-8000-000000000535',
  'match-result-1',
  'scoring-1',
  '01900000-0000-7000-8000-000000000511',
  repeat('d', 64),
  'server-test-1',
  'match-1',
  repeat('b', 64)
);

UPDATE hive_projection.match_result
   SET current_event_uuid = '01900000-0000-7000-8000-000000000406',
       current_state = 'corrected',
       matched_result_revision_id = '01900000-0000-7000-8000-000000000535'
 WHERE id = '01900000-0000-7000-8000-000000000600';

COMMIT;

SELECT pg_temp.assert_true(
  (
    SELECT current_event_uuid = '01900000-0000-7000-8000-000000000406'
       AND current_state = 'corrected'
      FROM hive_projection.match_result
     WHERE id = '01900000-0000-7000-8000-000000000600'
  ),
  'accepted correction appends one edge and advances the projected current pointer'
);

SELECT pg_temp.expect_sqlstate(
  $$UPDATE hive_projection.match_result
       SET current_event_uuid = '01900000-0000-7000-8000-000000000404',
           current_state = 'current'
     WHERE id = '01900000-0000-7000-8000-000000000600'$$,
  '23514'
);
