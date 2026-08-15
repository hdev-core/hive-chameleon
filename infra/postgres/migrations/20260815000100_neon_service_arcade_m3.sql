-- migrate:up

-- Publish Neon Service Arcade m3, carrying collision derived from the arena mesh.
--
-- m2 collided against geometry that did not belong to this map, and the volumes
-- it did carry were world axis-aligned bounds of prop clusters, so turned props
-- were represented by the upright envelope containing them rather than a box
-- around them. m3 replaces that with one fitted volume per prop.
--
-- Submitted map versions are immutable by design, so this publishes a new
-- version rather than editing m2, and withdraws m2's distributions so clients
-- are offered exactly one arcade.

DO $$
DECLARE
  official_map_id uuid;
  official_version_id uuid;
  seeded_manifest jsonb;
BEGIN
  SELECT id INTO official_map_id
    FROM content.map
   WHERE slug = 'neon-service-arcade' AND origin = 'official';

  IF official_map_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'the official neon-service-arcade map is missing';
  END IF;

  SELECT jsonb_set(
           jsonb_set(
             jsonb_set(manifest, '{content_version}', '"m3"'::jsonb, true),
             '{authority_geometry}',
             jsonb_build_object(
               'version', 'neon-service-arcade-authority-5',
               'digest',
               'sha256:0582228533b58772c3496385d088e068f903193dc386aa78af6e9e37b52eccb6'
             ),
             true
           ),
           '{asset_provenance,environment,collision}',
           '"derived from the arena mesh, one fitted volume per prop"'::jsonb,
           true
         )
    INTO seeded_manifest
    FROM content.map_version v
   WHERE v.map_id = official_map_id AND v.version_number = 'm2';

  IF seeded_manifest IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m2 is missing; cannot derive m3';
  END IF;

  INSERT INTO content.map_version (
    id, map_id, version_number, manifest, status,
    license_declaration_version, license_accepted_at,
    technical_validation, created_at, updated_at
  )
  VALUES (
    '019fab2b-c400-7000-8000-000000000019',
    official_map_id,
    'm3',
    seeded_manifest,
    'draft',
    'user-supplied-bundled-1',
    '2026-08-15T00:00:00Z',
    jsonb_build_object(
      'validated', true,
      'scope', 'bundled-authoritative-arena',
      'map_slug', 'neon-service-arcade',
      'authority_geometry_version', 'neon-service-arcade-authority-5',
      'authority_geometry_digest',
      'sha256:0582228533b58772c3496385d088e068f903193dc386aa78af6e9e37b52eccb6'
    ),
    '2026-08-15T00:00:00Z',
    '2026-08-15T00:00:00Z'
  )
  ON CONFLICT (map_id, version_number) DO NOTHING;

  SELECT id INTO official_version_id
    FROM content.map_version
   WHERE map_id = official_map_id
     AND version_number = 'm3'
     AND manifest #>> '{authority_geometry,version}' = 'neon-service-arcade-authority-5'
     AND manifest #>> '{authority_geometry,digest}'
       = 'sha256:0582228533b58772c3496385d088e068f903193dc386aa78af6e9e37b52eccb6';

  IF official_version_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m3 conflicts with the bundled release';
  END IF;

  INSERT INTO content.map_asset (
    id, map_version_id, kind, object_storage_key, media_type, size_bytes, sha256
  )
  SELECT
    '019fab2b-c400-7000-8000-00000000001a',
    official_version_id,
    'package',
    'bundled-in-client/neon-service-arcade/m3',
    'application/octet-stream',
    1,
    encode(digest(convert_to(manifest::text, 'UTF8'), 'sha256'), 'hex')
    FROM content.map_version WHERE id = official_version_id
  ON CONFLICT (object_storage_key) DO NOTHING;

  UPDATE content.map_version
     SET status = 'published',
         submitted_at = COALESCE(submitted_at, '2026-08-15T00:00:00Z'),
         approved_at  = COALESCE(approved_at,  '2026-08-15T00:00:00Z'),
         published_at = COALESCE(published_at, '2026-08-15T00:00:00Z'),
         updated_at   = '2026-08-15T00:00:00Z'
   WHERE id = official_version_id;

  INSERT INTO content.map_distribution (
    id, map_version_id, platform, state,
    required_game_build_version, required_protocol_version, published_at, created_at
  )
  VALUES
    ('019fab2b-c400-7000-8000-00000000001b', official_version_id, 'desktop', 'available',
     'hive-chameleon-m4-dev', 'm4-v2', '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z'),
    ('019fab2b-c400-7000-8000-00000000001c', official_version_id, 'web', 'available',
     'hive-chameleon-m4-dev', 'm4-v2', '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')
  ON CONFLICT (map_version_id, platform) DO NOTHING;

  -- Exactly one arcade is offered at a time.
  UPDATE content.map_distribution d
     SET state = 'withdrawn',
         -- a withdrawn distribution must carry the moment it was withdrawn,
         -- and it may not predate publication
         withdrawn_at = GREATEST(d.published_at, '2026-08-15T00:00:00Z')
    FROM content.map_version v
   WHERE d.map_version_id = v.id
     AND v.map_id = official_map_id
     AND v.version_number <> 'm3'
     AND d.state = 'available';

  IF NOT EXISTS (
    SELECT 1 FROM content.map_distribution d
      JOIN content.map_version v ON v.id = d.map_version_id
     WHERE v.map_id = official_map_id AND v.version_number = 'm3'
       AND d.state = 'available'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m3 was not made available';
  END IF;
END;
$$;

-- migrate:down

-- Forward-only: m2 collision does not match the shipped arena.
SELECT 1;
