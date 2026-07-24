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

Copy `.env.example` to `.env` and replace every placeholder. Start and migrate the application
PostgreSQL database first, then start the isolated Nakama database, one-shot Nakama schema
migration, and server:

```bash
docker compose -f infra/postgres/compose.yaml up -d postgres dbmate
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

Realtime issuance now requires a real NestJS access token backed by an active PostgreSQL session;
the former fixed development principal has been removed. Unity obtains the token through the auth
API before requesting a Nakama credential. Never serialize API, Nakama, or signing credentials
into a scene or production build.

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

`lobby.create`, `lobby.join`, `lobby.leave`, `lobby.update_configuration`,
`lobby.nominate_hunter`, and `lobby.start` drive the lobby and pre-round lifecycle through a
Nakama-authoritative match. Host commands lock and recheck both the current open
`game.lobby_host_assignment` and the caller's expected lobby version. Disconnecting or leaving
closes the membership and migrates the host in one serializable transaction; the empty lobby
closes without treating host ownership as a permanent role.

Hunter nomination is a toggle for the authenticated caller only. PostgreSQL stores it on the open
membership, so a replacement match handler rehydrates the exact nominee set instead of losing
pre-round intent. The match publishes the current nominee IDs in `lobby.state`, but never accepts a
player ID or role from the client. At start, PostgreSQL locks the exact host, lobby version,
membership, nomination flags, configuration, and published map version; the server then
prioritizes nominees, cryptographically fills any remaining Hunter slots, and transactionally
clears the consumed nomination flags. It inserts a durable `game.game_round` header in `preparing`
state while live assignments remain private authoritative-match state. Opcode `2` carries one
recipient's role assignment; opcode `3` carries the public round phase. Terminal
`game.round_participant` evidence is still written only when the round ends.

Card #32 advances Casual rounds through server-timed `preparing`, `hiding`, `hunting`, and
in-memory `terminal` phases. Each Hider receives a private server-generated target slot. A Hunter
may send only opcode `10` with a command ID and aim slot; the match validates role, phase, slot,
shells, reload timing, idempotency, and the server-owned slot occupancy. Opcodes `4`, `5`, and `6`
carry authoritative discoveries, private player state, and private fire results respectively.
Timeouts and all-Hiders-found outcomes are computed in the match loop. The durable terminal
transaction and `completed` database transition remain card #33, so a card #32 terminal state is
not yet acknowledged as a published result.

An empty lobby aborts its active nonterminal round transactionally. Reconnect restoration and
role restoration are deliberately left to their dedicated M4 card.

The runtime opens the application connection from `HC_NAKAMA_DATABASE_URL`. Production supplies a
dedicated login granted membership in the `hc_nakama` group role. Nakama's injected `*sql.DB`
continues to point only at Nakama's internal database and is never used for application schemas.

The remaining future RPCs stay registered as explicit `feature_not_ready` stubs until their cards
replace them with authoritative behavior.

The repository smoke command starts disposable application and Nakama databases, seeds two
short-lived real API sessions plus a published non-visual map record, and exercises the complete
bridge, host migration, nomination, server-only role assignment, round creation, same-assertion
replay denial, non-bridge authentication denial, server-timed Casual phases, rejected forged
outcomes, authoritative discovery, and a terminal Hunter win without printing credentials:

```bash
npm run realtime:smoke
```

Nakama's WebSocket protocol reports the intentional RPC runtime exception as realtime code `7`
while preserving the `feature_not_ready` message; HTTP RPC callers receive gRPC `UNIMPLEMENTED`.
