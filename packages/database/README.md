# Database package

This package centralizes the TypeScript PostgreSQL pool, transaction wrapper, and
application-owned UUIDv7 convention. It deliberately contains no migration-at-startup behavior:
deployments run the reviewed SQL migrations as a separate release step before starting services.

```ts
import { createDatabasePool, createUuidV7, withTransaction } from '@hive-chameleon/database';

const pool = createDatabasePool({ connectionString: process.env.DATABASE_URL });

await withTransaction(pool, async (client) => {
  await client.query(
    'INSERT INTO identity.player (id, hive_username, hive_control_state) VALUES ($1, $2, $3)',
    [createUuidV7(), 'alice', 'external_self_custodial'],
  );
});
```

Keep identifiers generated in the application. PostgreSQL validates the RFC 9562 version and
variant bits but is not the source of UUID values.
