-- migrate:up

-- 20260729000100_official_chroma_district.sql published prism-foundry m4-4 without a
-- content.map_asset row, because the bundled Low Poly City Starter Pack content is
-- licensed and cannot be redistributed through this project's object storage; developers
-- install it directly through Unity instead. That left match-publisher with no content
-- identity to hash for on-chain match-result payloads, since its candidate query requires
-- one 'package' asset per map version.
--
-- This migration publishes a new version, m4-5, whose package asset hashes only this
-- project's own manifest metadata (map slug, version, provenance JSON) -- never the
-- licensed asset pack itself -- to give match-publisher a legitimate, license-safe content
-- identity. Submitted map versions are immutable (content.hc_protect_submitted_map_version),
-- so this must be a new version rather than a retrofit of m4-4.
DO $$
DECLARE
  seeded_version_id constant uuid := '019fab2b-c400-7000-8000-000000000005';
  seeded_package_asset_id constant uuid := '019fab2b-c400-7000-8000-000000000006';
  seeded_desktop_distribution_id constant uuid := '019fab2b-c400-7000-8000-000000000007';
  seeded_web_distribution_id constant uuid := '019fab2b-c400-7000-8000-000000000008';
  official_map_id uuid;
  official_version_id uuid;
  seeded_manifest jsonb;
BEGIN
  SELECT id
    INTO official_map_id
    FROM content.map
   WHERE slug = 'prism-foundry'
     AND origin = 'official'
     AND creator_player_id IS NULL
     AND lifecycle = 'published';

  IF official_map_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'prism-foundry is not the published creatorless official map';
  END IF;

  seeded_manifest := jsonb_build_object(
    'schema_version', 1,
    'content_slug', 'prism-foundry',
    'display_name', 'Chroma District',
    'content_version', 'm4-5',
    'delivery', 'bundled_in_game_client',
    'asset_provenance', jsonb_build_object(
      'character_and_weapon', jsonb_build_object(
        'source', 'project-authored Blender assets'
      ),
      'environment', jsonb_build_object(
        'name', 'Low Poly City - Starter Pack',
        'publisher', 'MiniWorld Studio',
        'source', 'Unity Asset Store',
        'source_url',
          'https://assetstore.unity.com/packages/3d/environments/urban/low-poly-city-starter-pack-mini-world-studio-380946',
        'raw_source_redistribution', 'unreviewed_do_not_publish'
      )
    )
  );

  -- Inserted without submitted_at/approved_at/published_at so the package asset insert
  -- below is still permitted; the immutability trigger only guards already-submitted rows.
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
    seeded_version_id,
    official_map_id,
    'm4-5',
    seeded_manifest,
    'draft',
    'official-bundled-provenance-1',
    '2026-08-08T00:00:00Z',
    jsonb_build_object(
      'validated', true,
      'scope', 'bundled-client-m4-5',
      'map_slug', 'prism-foundry'
    ),
    '2026-08-08T00:00:00Z',
    '2026-08-08T00:00:00Z'
  )
  ON CONFLICT (map_id, version_number) DO NOTHING;

  SELECT id
    INTO official_version_id
    FROM content.map_version
   WHERE map_id = official_map_id
     AND version_number = 'm4-5';

  IF official_version_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'prism-foundry m4-5 was not created';
  END IF;

  -- License-safe content identity: hashes only this project's own manifest JSON, never the
  -- licensed Low Poly City Starter Pack content, which stays outside object storage entirely.
  INSERT INTO content.map_asset (
    id, map_version_id, kind, object_storage_key, media_type, size_bytes, sha256
  )
  SELECT
    seeded_package_asset_id,
    official_version_id,
    'package',
    'bundled-in-client/prism-foundry/m4-5',
    'application/octet-stream',
    1,
    encode(digest(convert_to(manifest::text, 'UTF8'), 'sha256'), 'hex')
    FROM content.map_version
   WHERE id = official_version_id
  ON CONFLICT (object_storage_key) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM content.map_asset
     WHERE map_version_id = official_version_id AND kind = 'package'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'prism-foundry m4-5 package asset was not created';
  END IF;

  -- The only allowed mutation of a not-yet-submitted row: the one-time submit/approve/publish
  -- transition. content.hc_protect_submitted_map_version permits OLD.submitted_at IS NULL.
  UPDATE content.map_version
     SET status = 'published',
         submitted_at = '2026-08-08T00:00:00Z',
         approved_at = '2026-08-08T00:00:00Z',
         published_at = '2026-08-08T00:00:00Z'
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
      seeded_desktop_distribution_id,
      official_version_id,
      'desktop',
      'available',
      'hive-chameleon-m4-dev',
      'm4-v2',
      '2026-08-08T00:00:00Z',
      '2026-08-08T00:00:00Z'
    ),
    (
      seeded_web_distribution_id,
      official_version_id,
      'web',
      'available',
      'hive-chameleon-m4-dev',
      'm4-v2',
      '2026-08-08T00:00:00Z',
      '2026-08-08T00:00:00Z'
    )
  ON CONFLICT (map_version_id, platform) DO NOTHING;

  IF (
    SELECT count(*) <> 2
      FROM content.map_distribution
     WHERE map_version_id = official_version_id
       AND platform IN ('desktop', 'web')
       AND state = 'available'
       AND required_game_build_version = 'hive-chameleon-m4-dev'
       AND required_protocol_version = 'm4-v2'
       AND published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'prism-foundry m4-5 distributions conflict with the m4 development client release';
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
