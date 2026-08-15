\echo 'authoritative result revision lineage'

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
      FROM game.round_result_revision
     WHERE round_id = '01900000-0000-7000-8000-000000000530'
  ),
  'the completed round retains its initial result and one correction'
);

SELECT pg_temp.assert_true(
  (
    SELECT current_revision.revision_number = 2
       AND current_revision.revision_type = 'correction'
       AND current_revision.previous_revision_id =
             '01900000-0000-7000-8000-000000000533'::uuid
       AND convert_from(current_revision.canonical_complete_result, 'UTF8') =
             '{"round":"01900000-0000-7000-8000-000000000530","revision":2}'
       AND current_revision.canonical_complete_result_sha256 =
             encode(digest(current_revision.canonical_complete_result, 'sha256'), 'hex')
      FROM game.round_result_revision AS current_revision
     WHERE current_revision.id = '01900000-0000-7000-8000-000000000535'
  ),
  'the correction is a linear, exact, hash-bound local revision'
);
