-- migrate:up

-- Chroma District is bundled with the m4-4 client. The catalog keeps the historical
-- `prism-foundry` slug as its stable network identity.
--
-- The Asset Store entry recorded in the manifest identifies provenance only. In particular,
-- `raw_source_redistribution` deliberately remains `unreviewed`: this migration does not assert
-- that the imported source package may be redistributed through the public source repository.
DO $$
DECLARE
  seeded_map_id constant uuid := '019fab2b-c400-7000-8000-000000000001';
  seeded_version_id constant uuid := '019fab2b-c400-7000-8000-000000000002';
  seeded_desktop_distribution_id constant uuid :=
    '019fab2b-c400-7000-8000-000000000003';
  seeded_web_distribution_id constant uuid :=
    '019fab2b-c400-7000-8000-000000000004';
  official_map_id uuid;
  official_version_id uuid;
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
    seeded_map_id,
    'official',
    NULL,
    'prism-foundry',
    'Chroma District',
    'Bundled official city arena for the Hive Chameleon m4 vertical slice.',
    'published',
    '2026-07-29T00:00:00Z',
    '2026-07-29T00:00:00Z'
  )
  ON CONFLICT (slug) DO NOTHING;

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
        'prism-foundry already exists but is not the published creatorless official map';
  END IF;

  INSERT INTO content.map_version (
    id,
    map_id,
    version_number,
    manifest,
    status,
    license_declaration_version,
    license_accepted_at,
    technical_validation,
    submitted_at,
    approved_at,
    published_at,
    created_at,
    updated_at
  )
  VALUES (
    seeded_version_id,
    official_map_id,
    'm4-4',
    jsonb_build_object(
      'schema_version', 1,
      'content_slug', 'prism-foundry',
      'display_name', 'Chroma District',
      'content_version', 'm4-4',
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
    ),
    'published',
    'official-bundled-provenance-1',
    '2026-07-29T00:00:00Z',
    jsonb_build_object(
      'validated', true,
      'scope', 'bundled-client-m4-4',
      'map_slug', 'prism-foundry'
    ),
    '2026-07-29T00:00:00Z',
    '2026-07-29T00:00:00Z',
    '2026-07-29T00:00:00Z',
    '2026-07-29T00:00:00Z',
    '2026-07-29T00:00:00Z'
  )
  ON CONFLICT (map_id, version_number) DO NOTHING;

  SELECT id
    INTO official_version_id
    FROM content.map_version
   WHERE map_id = official_map_id
     AND version_number = 'm4-4'
     AND status = 'published'
     AND manifest ->> 'content_slug' = 'prism-foundry'
     AND manifest ->> 'content_version' = 'm4-4'
     AND manifest #>> '{asset_provenance,environment,raw_source_redistribution}'
       = 'unreviewed_do_not_publish';

  IF official_version_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'prism-foundry m4-4 already exists but does not match the official published manifest';
  END IF;

  INSERT INTO content.map_distribution (
    id,
    map_version_id,
    platform,
    state,
    required_game_build_version,
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
      '2026-07-29T00:00:00Z',
      '2026-07-29T00:00:00Z'
    ),
    (
      seeded_web_distribution_id,
      official_version_id,
      'web',
      'available',
      'hive-chameleon-m4-dev',
      '2026-07-29T00:00:00Z',
      '2026-07-29T00:00:00Z'
    )
  ON CONFLICT (map_version_id, platform) DO NOTHING;

  IF (
    SELECT count(*) <> 2
      FROM content.map_distribution
     WHERE map_version_id = official_version_id
       AND platform IN ('desktop', 'web')
       AND state = 'available'
       AND required_game_build_version = 'hive-chameleon-m4-dev'
       AND published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'prism-foundry m4-4 distributions conflict with the m4 development client release';
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
