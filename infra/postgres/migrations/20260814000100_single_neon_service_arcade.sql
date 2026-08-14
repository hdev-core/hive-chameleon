-- migrate:up

-- The supplied Neon Service Arcade build supersedes every earlier arena release.
-- Keep historical map/version rows for round auditability, but expose only this
-- bundled release to compatible desktop and WebGL clients.
DO $$
DECLARE
  official_map_id uuid;
  official_version_id uuid;
  seeded_manifest jsonb;
BEGIN
  INSERT INTO content.map (
    id,
    origin,
    creator_player_id,
    slug,
    title,
    description,
    lifecycle,
    created_at,
    updated_at
  )
  VALUES (
    '019fab2b-c400-7000-8000-000000000010',
    'official',
    NULL,
    'neon-service-arcade',
    'Neon Service Arcade',
    'An indoor arcade, prize cafe, and repair workshop built for close pursuit.',
    'published',
    '2026-08-14T00:00:00Z',
    '2026-08-14T00:00:00Z'
  )
  ON CONFLICT (slug) DO NOTHING;

  SELECT id
    INTO official_map_id
    FROM content.map
   WHERE slug = 'neon-service-arcade'
     AND origin = 'official'
     AND creator_player_id IS NULL
     AND lifecycle = 'published'
     AND title = 'Neon Service Arcade';

  IF official_map_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade conflicts with the official map catalog';
  END IF;

  seeded_manifest := jsonb_build_object(
    'schema_version', 1,
    'content_slug', 'neon-service-arcade',
    'display_name', 'Neon Service Arcade',
    'content_version', 'm2',
    'delivery', 'bundled_in_game_client',
    'asset_provenance', jsonb_build_object(
      'environment', jsonb_build_object(
        'source', 'user-supplied Blender arena build',
        'redistribution', 'bundled with game client'
      )
    ),
    'authority_geometry', jsonb_build_object(
      'version', 'neon-service-arcade-authority-2',
      'digest', 'sha256:630e96108db3af745cadc89f5bce8b16cef0024172dba2733d510c3576ede412'
    )
  );

  INSERT INTO content.map_version (
    id,
    map_id,
    version_number,
    manifest,
    status,
    license_declaration_version,
    license_accepted_at,
    technical_validation,
    created_at,
    updated_at
  )
  VALUES (
    '019fab2b-c400-7000-8000-000000000015',
    official_map_id,
    'm2',
    seeded_manifest,
    'draft',
    'user-supplied-bundled-1',
    '2026-08-14T00:00:00Z',
    jsonb_build_object(
      'validated', true,
      'scope', 'bundled-authoritative-arena',
      'map_slug', 'neon-service-arcade',
      'authority_geometry_version', 'neon-service-arcade-authority-2',
      'authority_geometry_digest', 'sha256:630e96108db3af745cadc89f5bce8b16cef0024172dba2733d510c3576ede412'
    ),
    '2026-08-14T00:00:00Z',
    '2026-08-14T00:00:00Z'
  )
  ON CONFLICT (map_id, version_number) DO NOTHING;

  SELECT id
    INTO official_version_id
    FROM content.map_version
   WHERE map_id = official_map_id
     AND version_number = 'm2'
     AND manifest ->> 'content_slug' = 'neon-service-arcade'
     AND manifest #>> '{authority_geometry,version}'
       = 'neon-service-arcade-authority-2'
     AND manifest #>> '{authority_geometry,digest}'
       = 'sha256:630e96108db3af745cadc89f5bce8b16cef0024172dba2733d510c3576ede412';

  IF official_version_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m2 conflicts with the bundled release';
  END IF;

  INSERT INTO content.map_asset (
    id,
    map_version_id,
    kind,
    object_storage_key,
    media_type,
    size_bytes,
    sha256
  )
  SELECT
    '019fab2b-c400-7000-8000-000000000016',
    official_version_id,
    'package',
    'bundled-in-client/neon-service-arcade/m2',
    'application/octet-stream',
    1,
    encode(digest(convert_to(manifest::text, 'UTF8'), 'sha256'), 'hex')
    FROM content.map_version
   WHERE id = official_version_id
  ON CONFLICT (object_storage_key) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM content.map_asset
     WHERE map_version_id = official_version_id
       AND kind = 'package'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m2 package identity was not created';
  END IF;

  UPDATE content.map_version
     SET status = 'published',
         submitted_at = COALESCE(submitted_at, '2026-08-14T00:00:00Z'),
         approved_at = COALESCE(approved_at, '2026-08-14T00:00:00Z'),
         published_at = COALESCE(published_at, '2026-08-14T00:00:00Z'),
         updated_at = '2026-08-14T00:00:00Z'
   WHERE id = official_version_id;

  INSERT INTO content.map_distribution (
    id,
    map_version_id,
    platform,
    state,
    required_game_build_version,
    required_protocol_version,
    published_at,
    created_at
  )
  VALUES
    (
      '019fab2b-c400-7000-8000-000000000017',
      official_version_id,
      'desktop',
      'available',
      'hive-chameleon-m4-dev',
      'm4-v2',
      '2026-08-14T00:00:00Z',
      '2026-08-14T00:00:00Z'
    ),
    (
      '019fab2b-c400-7000-8000-000000000018',
      official_version_id,
      'web',
      'available',
      'hive-chameleon-m4-dev',
      'm4-v2',
      '2026-08-14T00:00:00Z',
      '2026-08-14T00:00:00Z'
    )
  ON CONFLICT (map_version_id, platform) DO UPDATE
    SET state = 'available',
        required_game_build_version = EXCLUDED.required_game_build_version,
        required_protocol_version = EXCLUDED.required_protocol_version,
        published_at = EXCLUDED.published_at,
        withdrawn_at = NULL;

  UPDATE content.map_distribution AS distribution
     SET state = 'withdrawn',
         withdrawn_at = GREATEST(
           distribution.published_at,
           '2026-08-14T00:00:00Z'::timestamptz
         )
    FROM content.map_version AS version
    JOIN content.map AS map_definition ON map_definition.id = version.map_id
   WHERE distribution.map_version_id = version.id
     AND map_definition.origin = 'official'
     AND distribution.state = 'available'
     AND distribution.map_version_id <> official_version_id;

  IF (
    SELECT count(*) <> 2
      FROM content.map_distribution
     WHERE map_version_id = official_version_id
       AND platform IN ('desktop', 'web')
       AND state = 'available'
       AND required_game_build_version = 'hive-chameleon-m4-dev'
       AND required_protocol_version = 'm4-v2'
       AND published_at IS NOT NULL
       AND withdrawn_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'neon-service-arcade m2 distributions are incompatible';
  END IF;
END;
$$;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
