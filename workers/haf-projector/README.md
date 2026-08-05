# HAF projector foundation

This workspace reads Hive history through a provider-neutral HAfAH adapter and projects only
locally validated Hive Chameleon operations. It has no broadcast or signer capability.

The source adapter treats HAfAH operation IDs as decimal strings, verifies block identity through
`global-state`, and obtains both LIB height and block ID independently through Hive RPC. Operation
fetches are bracketed by matching HAfAH block snapshots. Before promotion, the projector requires
the RPC LIB identity to match HAfAH and rechecks the stored finalizable checkpoint. It stores a
checkpoint for every processed block, including empty blocks, detects replacement parents, retains
reverted evidence, and refuses to rewrite an irreversible block.

HAfAH virtual operations may carry an originating transaction ID. A real ID is preserved; null and
the all-zero HAfAH sentinel normalize to no transaction identity.

Persistence is the `ProjectionStore` port. The PostgreSQL implementation uses #22's
`hive_projection.block_checkpoint`, raw operation validation fields, and `sync_cursor` in one
transaction per applied block. Accepted application operations are retained immediately as
reversible raw evidence. Collectible ownership views are materialized only when the source operation becomes
irreversible, so a pre-LIB fork can revert pending evidence without corrupting the business view.
The included in-memory store is exported only from the testing subpath and refuses production use.

## Run the worker

The workspace includes the executable composition: it validates configuration, connects the
shared PostgreSQL pool through the projection-store adapter, polls with bounded exponential
failure backoff, and drains the active bounded cycle on `SIGINT` or `SIGTERM` before closing the
pool. Logs contain stable event/error codes and counters, not source/database URLs or error text
that could include credentials.

Apply the reviewed migrations as a release step first; the worker never migrates a database on
startup. Then copy `.env.example` to `.env` and replace every identity placeholder:

```bash
cp workers/haf-projector/.env.example workers/haf-projector/.env
npm run build --workspace @hive-chameleon/haf-projector
npm run start --workspace @hive-chameleon/haf-projector
```

`DATABASE_URL`, both source URLs, the source/network identity, HAfAH operation type IDs, and the
collectible-issuer allow-list are mandatory. An explicitly empty account list means deny all for
that event family. Production database URLs must select `sslmode=require`, `verify-ca`, or
`verify-full`; source URLs are always credential-free HTTPS. Page size, request timeout, database
pool bounds, polling/backoff, clock skew, batch size, and maximum reorganization depth have
validated conservative defaults and optional overrides documented in `.env.example`. There is no
hard-coded production endpoint, database credential, operation type ID, or Hive account.

The database login named by `DATABASE_URL` must be a member of the `hc_projector` NOLOGIN group
role. Every checked-out connection executes `SET ROLE hc_projector` and verifies `current_role`
before any projector query; a connection that cannot establish that boundary is destroyed and the
worker fails closed.

Development uses the same composition with watch mode:

```bash
npm run dev --workspace @hive-chameleon/haf-projector
```

## Verify

```bash
npm run typecheck --workspace @hive-chameleon/haf-projector
npm run test --workspace @hive-chameleon/haf-projector
```
