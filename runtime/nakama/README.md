# Nakama Go runtime

This module targets Nakama `3.39.0` and `nakama-common` `1.46.0`. Build the production plugin
through the matching `nakama-pluginbuilder` image in the Dockerfile; a host-built plugin can be
incompatible when its OS, Go toolchain, or shared dependency versions differ from Nakama.

Local source checks:

```bash
go test ./...
go vet ./...
```

## Local service

Copy `.env.example` to `.env`, replace every placeholder, then start the isolated Nakama database,
one-shot schema migration, and server:

```bash
docker compose --env-file runtime/nakama/.env -f runtime/nakama/compose.yaml up --build
```

Nakama listens on `127.0.0.1:7350`, its local console on `127.0.0.1:7351`, and Prometheus metrics
on `127.0.0.1:7354`. The database in this compose project is Nakama's internal database. It is not
the application PostgreSQL database defined by the product data model, and runtime code must not
use Nakama's injected `*sql.DB` handle for application schemas.

To run NestJS with the same bridge configuration, export the ignored local file before starting the
API:

```bash
set -a
source runtime/nakama/.env
set +a
npm run dev
```

The development principal is deliberately unavailable unless explicitly enabled, acknowledged,
and supplied through the configured bearer token. Production configuration rejects this mode.
The Unity desktop development client reads `HIVE_CHAMELEON_API_URL`, `NAKAMA_SERVER_KEY`, and
`REALTIME_DEV_BEARER_TOKEN` from its environment. With no local credentials it stays offline and
the scaffold build continues normally. WebGL cannot inherit desktop environment variables, so its
local-only values must be injected by the development build pipeline; never serialize them into a
production scene or build.

## Realtime contract boundary

NestJS signs a compact, short-lived custom-auth assertion. The Go authentication hook verifies it,
atomically consumes its nonce in server-only Nakama storage, replaces every caller-supplied
identity variable, and binds the Nakama token to the application player and game-session UUIDs.
Concurrent reuse is rejected through Nakama's optimistic storage-write retry, and authentication
fails closed if replay storage is unavailable. The client receives neither the assertion nor the
Nakama refresh token.

The runtime also denies Nakama's built-in custom-ID link/unlink, account update, and account
deletion endpoints. Account identity and lifecycle remain product-API responsibilities, so a
client cannot preclaim another player UUID or detach its bridged identity.

The documented lobby RPC names and `match.reconnect` are registered but return
`feature_not_ready` with gRPC `UNIMPLEMENTED`. This is intentional: later gameplay cards replace
the stubs with authoritative behavior without allowing a placeholder to report false success.

With the compose stack and NestJS API running from the same environment, exercise the complete
bridge, same-assertion replay denial, and non-bridge authentication denial without printing
credentials:

```bash
node runtime/nakama/smoke.mjs
```

Nakama's WebSocket protocol reports the intentional RPC runtime exception as realtime code `7`
while preserving the `feature_not_ready` message; HTTP RPC callers receive gRPC `UNIMPLEMENTED`.
