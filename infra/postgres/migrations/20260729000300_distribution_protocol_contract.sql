-- migrate:up

ALTER TABLE content.map_distribution
  ADD COLUMN required_protocol_version varchar(64);

ALTER TABLE content.map_distribution
  ADD CONSTRAINT chk_map_distribution_protocol_version
  CHECK (
    required_protocol_version IS NULL
    OR (
      required_protocol_version = btrim(required_protocol_version)
      AND required_protocol_version <> ''
    )
  );

UPDATE content.map_distribution AS distribution
   SET required_protocol_version = 'm4-v2'
  FROM content.map_version AS version
  JOIN content.map AS map_definition
    ON map_definition.id = version.map_id
 WHERE distribution.map_version_id = version.id
   AND map_definition.slug = 'prism-foundry'
   AND map_definition.origin = 'official'
   AND map_definition.lifecycle = 'published'
   AND map_definition.creator_player_id IS NULL
   AND version.version_number = 'm4-4'
   AND version.status = 'published'
   AND distribution.platform IN ('desktop', 'web')
   AND distribution.state = 'available'
   AND distribution.required_game_build_version = 'hive-chameleon-m4-dev'
   AND distribution.published_at IS NOT NULL;

DO $$
BEGIN
  IF (
    SELECT count(*) <> 2
      FROM content.map_distribution AS distribution
      JOIN content.map_version AS version
        ON version.id = distribution.map_version_id
      JOIN content.map AS map_definition
        ON map_definition.id = version.map_id
     WHERE map_definition.slug = 'prism-foundry'
       AND map_definition.origin = 'official'
       AND map_definition.lifecycle = 'published'
       AND map_definition.creator_player_id IS NULL
       AND version.version_number = 'm4-4'
       AND version.status = 'published'
       AND distribution.platform IN ('desktop', 'web')
       AND distribution.state = 'available'
       AND distribution.required_game_build_version = 'hive-chameleon-m4-dev'
       AND distribution.required_protocol_version = 'm4-v2'
       AND distribution.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'prism-foundry m4-4 distributions do not declare one shared supported protocol';
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
