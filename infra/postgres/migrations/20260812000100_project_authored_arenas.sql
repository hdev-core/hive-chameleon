-- migrate:up

-- Publish the two project-authored arenas bundled with the Unity client. Their package
-- identities cover the repository-owned map manifests and authority geometry; no external
-- Asset Store content is involved.
DO $$
DECLARE
  candidate record;
  official_map_id uuid;
  official_version_id uuid;
  seeded_manifest jsonb;
BEGIN
  FOR candidate IN
    SELECT *
      FROM (
        VALUES
          (
            '019fab2b-c400-7000-8000-000000000010'::uuid,
            '019fab2b-c400-7000-8000-000000000011'::uuid,
            '019fab2b-c400-7000-8000-000000000012'::uuid,
            '019fab2b-c400-7000-8000-000000000013'::uuid,
            '019fab2b-c400-7000-8000-000000000014'::uuid,
            'neon-service-arcade'::text,
            'Neon Service Arcade'::text,
            'An indoor arcade, prize cafe, and repair workshop built for close pursuit.'::text,
            'm1'::text,
            'neon-service-arcade-authority-1'::text,
            'sha256:258519b782eca806c111a7492ad027afbe3a0c3450dd1af574429b8f4952bf44'::text
          ),
          (
            '019fab2b-c400-7000-8000-000000000020'::uuid,
            '019fab2b-c400-7000-8000-000000000021'::uuid,
            '019fab2b-c400-7000-8000-000000000022'::uuid,
            '019fab2b-c400-7000-8000-000000000023'::uuid,
            '019fab2b-c400-7000-8000-000000000024'::uuid,
            'patchwork-playhouse'::text,
            'Patchwork Playhouse'::text,
            'A theatre spanning its foyer, auditorium, stage, and crowded backstage.'::text,
            'm1'::text,
            'patchwork-playhouse-authority-1'::text,
            'sha256:c8cbf120ac1ef681329f33072aca394a635f8248b586a0287fc102226aa7afc5'::text
          )
      ) AS value(
        map_id,
        version_id,
        package_asset_id,
        desktop_distribution_id,
        web_distribution_id,
        slug,
        title,
        description,
        content_version,
        authority_geometry_version,
        authority_geometry_digest
      )
  LOOP
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
      candidate.map_id,
      'official',
      NULL,
      candidate.slug,
      candidate.title,
      candidate.description,
      'published',
      '2026-08-12T00:00:00Z',
      '2026-08-12T00:00:00Z'
    )
    ON CONFLICT (slug) DO NOTHING;

    SELECT id
      INTO official_map_id
      FROM content.map
     WHERE slug = candidate.slug
       AND origin = 'official'
       AND creator_player_id IS NULL
       AND lifecycle = 'published'
       AND title = candidate.title;

    IF official_map_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = candidate.slug || ' conflicts with the official map catalog';
    END IF;

    seeded_manifest := jsonb_build_object(
      'schema_version', 1,
      'content_slug', candidate.slug,
      'display_name', candidate.title,
      'content_version', candidate.content_version,
      'delivery', 'bundled_in_game_client',
      'asset_provenance', jsonb_build_object(
        'environment', jsonb_build_object(
          'source', 'project-authored Blender assets',
          'redistribution', 'repository-owned'
        )
      ),
      'authority_geometry', jsonb_build_object(
        'version', candidate.authority_geometry_version,
        'digest', candidate.authority_geometry_digest
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
      candidate.version_id,
      official_map_id,
      candidate.content_version,
      seeded_manifest,
      'draft',
      'project-owned-bundled-1',
      '2026-08-12T00:00:00Z',
      jsonb_build_object(
        'validated', true,
        'scope', 'bundled-authoritative-arena',
        'map_slug', candidate.slug,
        'authority_geometry_version', candidate.authority_geometry_version,
        'authority_geometry_digest', candidate.authority_geometry_digest
      ),
      '2026-08-12T00:00:00Z',
      '2026-08-12T00:00:00Z'
    )
    ON CONFLICT (map_id, version_number) DO NOTHING;

    SELECT id
      INTO official_version_id
      FROM content.map_version
     WHERE map_id = official_map_id
       AND version_number = candidate.content_version
       AND manifest ->> 'content_slug' = candidate.slug
       AND manifest #>> '{authority_geometry,version}'
         = candidate.authority_geometry_version
       AND manifest #>> '{authority_geometry,digest}'
         = candidate.authority_geometry_digest;

    IF official_version_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = candidate.slug || ' map version conflicts with the bundled release';
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
      candidate.package_asset_id,
      official_version_id,
      'package',
      'bundled-in-client/' || candidate.slug || '/' || candidate.content_version,
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
        MESSAGE = candidate.slug || ' package identity was not created';
    END IF;

    UPDATE content.map_version
       SET status = 'published',
           submitted_at = '2026-08-12T00:00:00Z',
           approved_at = '2026-08-12T00:00:00Z',
           published_at = '2026-08-12T00:00:00Z'
     WHERE id = official_version_id
       AND submitted_at IS NULL;

    IF NOT EXISTS (
      SELECT 1
        FROM content.map_version
       WHERE id = official_version_id
         AND status = 'published'
         AND published_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = candidate.slug || ' map version was not published';
    END IF;

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
        candidate.desktop_distribution_id,
        official_version_id,
        'desktop',
        'available',
        'hive-chameleon-m4-dev',
        'm4-v2',
        '2026-08-12T00:00:00Z',
        '2026-08-12T00:00:00Z'
      ),
      (
        candidate.web_distribution_id,
        official_version_id,
        'web',
        'available',
        'hive-chameleon-m4-dev',
        'm4-v2',
        '2026-08-12T00:00:00Z',
        '2026-08-12T00:00:00Z'
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
        MESSAGE = candidate.slug || ' distributions are incompatible';
    END IF;
  END LOOP;
END;
$$;

-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION
    'Hive Chameleon database migrations are forward-only; restore a tested backup and apply a forward repair';
END;
$$;
