-- migrate:up

-- Republish the Neon Service Arcade authority geometry.
--
-- The bundled geometry the server collides against was a 48-box approximation
-- that did not follow the map it belongs to. Measured against the arena's own
-- visual geometry, 80 of its 116 solid props had under a quarter of their
-- volume covered: every arcade cabinet, both vending machines, the cafe
-- counters and the prize claw machine were effectively absent, so players
-- walked through them while colliding with boxes standing in open floor.
--
-- The replacement is derived directly from the arena mesh, so the catalog has
-- to advertise the new geometry identity or clients will keep validating
-- against the superseded digest and refuse to start a round.

BEGIN;

DO $$
DECLARE
  official_map_id uuid;
  official_version_id uuid;
BEGIN
  SELECT id
    INTO official_map_id
    FROM content.map
   WHERE slug = 'neon-service-arcade'
     AND origin = 'official';

  IF official_map_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'the official neon-service-arcade map is missing';
  END IF;

  SELECT id
    INTO official_version_id
    FROM content.map_version
   WHERE map_id = official_map_id
     AND version_number = 'm2';

  IF official_version_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'the official neon-service-arcade m2 version is missing';
  END IF;

  UPDATE content.map_version
     SET manifest = jsonb_set(
           manifest,
           '{authority_geometry}',
           jsonb_build_object(
             'version', 'neon-service-arcade-authority-5',
             'digest',
             'sha256:5f7cb5f35e15ba004da1fb37229c75c07d8cc3f81eabe2eed4f8ab42051ad1aa'
           ),
           true
         ),
         technical_validation = jsonb_set(
           jsonb_set(
             technical_validation,
             '{authority_geometry_version}',
             '"neon-service-arcade-authority-5"'::jsonb,
             true
           ),
           '{authority_geometry_digest}',
           '"sha256:5f7cb5f35e15ba004da1fb37229c75c07d8cc3f81eabe2eed4f8ab42051ad1aa"'::jsonb,
           true
         ),
         updated_at = now()
   WHERE id = official_version_id;

  IF NOT EXISTS (
    SELECT 1
      FROM content.map_version
     WHERE id = official_version_id
       AND manifest #>> '{authority_geometry,version}'
         = 'neon-service-arcade-authority-5'
       AND manifest #>> '{authority_geometry,digest}'
         = 'sha256:5f7cb5f35e15ba004da1fb37229c75c07d8cc3f81eabe2eed4f8ab42051ad1aa'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m2 did not adopt the republished authority geometry';
  END IF;
END;
$$;

COMMIT;

-- migrate:down

-- Forward-only: the superseded geometry does not match the shipped arena and
-- must not be restored.
SELECT 1;
