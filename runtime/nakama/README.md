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
outside an active round closes the membership and migrates the host in one serializable
transaction; the empty lobby closes without treating host ownership as a permanent role. New
lobbies select only the published official `neon-service-arcade` content version `m2` when both
desktop and web distributions declare the same supported game build and realtime protocol. Configuration
and round start reject every other map UUID, version, lifecycle, unavailable distribution, or
incompatible build/protocol contract. Public round snapshots carry the immutable map-version UUID,
content version, required game build, and required protocol loaded from that distribution contract
plus the version and SHA-256 digest of the server collision proxy, so Unity can fail closed instead
of rendering or speaking a different bundled release or geometry contract.

Hunter nomination is a toggle for the authenticated caller only. PostgreSQL stores it on the open
membership, so a replacement match handler rehydrates the exact nominee set instead of losing
pre-round intent. The match publishes the current nominee IDs in `lobby.state`, but never accepts a
player ID or role from the client. At start, PostgreSQL locks the exact host, lobby version,
membership, nomination flags, configuration, and published map version; the server then
prioritizes nominees, cryptographically fills any remaining Hunter slots, and transactionally
clears the consumed nomination flags. It inserts a durable `game.game_round` header in `preparing`
state and atomically creates a private, versioned `game.round_live_checkpoint`; live assignments
remain private authoritative-match state and are never added to a public snapshot. Opcode `2`
carries one recipient's role assignment; opcode `3` carries the public round phase. Terminal
`game.round_participant` evidence is still written only when the round ends.

The authoritative round engine advances both Casual and Infection through server-timed
`preparing`, `hiding`, `hunting`, `answer_check`, and `completed` phases. A Hunter sends opcode
`10` with a command ID, pitch-aware aim yaw/pitch, and an optional `target_player_id`; omitting the
target records a deliberate miss. An accepted shot always consumes a shell and begins the server
reload interval. The match validates role, phase, shells, reload timing, idempotency, the aim delta
from the last accepted avatar orientation, and whether the requested player is a still-active
Hider. A named target is eligible only when the Hunter has a recent same-round avatar snapshot and
the 80-metre ray hits the target's authoritative capsule before any wall, prop, or arena
boundary in the pinned collision proxy. The last accepted Hider snapshot remains targetable even
when that Hider stops publishing, preventing stale-state immunity. A stale or missing Hunter
snapshot, missing target snapshot, out-of-range target, invalid aim, or blocked line of sight
becomes a shell-consuming miss. Unknown, Hunter, and already-found player IDs also resolve as
misses. The client reports its humanoid raycast target and aim, but it cannot declare a hit or
outcome. Opcodes
`4`, `5`, and `6` carry authoritative discoveries, private player state, and private fire results
respectively. Timeouts and all-Hiders-found outcomes are computed in the match loop. In Infection,
a discovered Hider becomes a server-authorized Hunter with a fresh bounded shell state, and the
conversion flag, initial role, and final role remain in the terminal result.

Opcode `14` relays a participant's humanoid avatar state using flat position, yaw, pitch, color,
and pose fields. The server seeds every participant at a deterministic role spawn, rejects
coordinates outside Neon Service Arcade, rejects endpoints or swept player capsules that intersect
the pinned analytic proxy (48 oriented boxes and two cylindrical proxies), and rejects horizontal,
vertical, yaw, or pitch deltas outside its server-time-based movement envelope. Floor meshes remain
traversal support rather than blocking
geometry. It also rejects caller-supplied identity/role fields, supplies the round, stable player
ID, optional Hive display name, current role/status, sequence, and timestamp, and publishes that
snapshot on opcode `15`. A rejected avatar command receives a private reliable copy of the last
accepted snapshot marked `correction`, allowing the owning client to reconcile without treating
ordinary avatar echoes as corrections.
Casual Hiders see one another while hiding, whereas active Infection Hiders do not see one another.
Hunters receive active Hider snapshots during Hunt, and eligible spectators receive every
participant snapshot in every active phase. This verifies submitted transforms, swept static
collision, and fire line of sight, but it is not a full server-side input, gravity, or dynamic-body
simulation.

Join-in-progress members and found Casual Hiders receive private spectator eligibility on opcode
`7`, including the supported first-person, third-person, and free-camera modes. The snapshot carries
the authoritative phase plus every visible player's current role and status; eligible spectators
can see all Hider avatars and player names. Converted Infection Hiders remain active Hunters during
Hunt. In Answer Check, original and converted Hiders enter spectator presentation while original
Hunters remain controllable in the 3D map and may continue relaying avatar movement. Completed
rounds expose terminal spectator eligibility to every participant. Answer Check remains open for
15 seconds: opcode `9` reveals each found, converted, or surviving Hider with its server-derived
current role/status and latest bounded humanoid position, yaw, colors, pose, sequence, and timestamp
when available. Client opcode `11`
records at most one idempotent non-self disguise like per eligible participant. Server opcode `8`
publishes cached versioned `scoring-1` provisional batches every 30 seconds while a round is active.
A reconnect receives the current cached batch without advancing that cadence. Answer Check and
terminal transitions publish an immediate final score, and each accepted like publishes an
immediate updated final score; opcode `12` privately acknowledges like commands.

An unexpected active-round disconnect reserves the authenticated participant and all server-owned
simulation state for 60 seconds. A one-second private-checkpoint heartbeat also gives a restarted
Nakama match a bounded crash timestamp: `MatchInit` rehydrates the checkpoint, synthesizes any
missing participant reservations from that persisted timestamp, and compare-and-swap checkpoints
them before accepting a join. Repeated restarts cannot extend the deadline.
`match.reconnect` can claim only that player's still-valid reservation; joining the returned
authoritative match restores the same current role, status, shells, discoveries, phase, avatar
snapshot, score-batch cadence, and terminal outcome. Opcode `13` privately confirms restoration.
The reconnect never accepts role or outcome fields from the client, delays host migration until
reservation expiry, and records the successful restoration in terminal participant evidence.
Explicit `lobby.leave` remains immediate.

The private checkpoint contains role assignments/current Infection conversions, ammunition and
reload deadlines, processed fire/like command caches, discoveries, likes, accepted avatars, the
cached initial-Hider scoreboard and next 30-second batch deadline, and reconnect reservations.
Accepted authoritative commands and transitions are persisted before their result is broadcast; avatar
updates are coalesced to the bounded checkpoint interval. `updated_at` compare-and-swap fencing
terminates stale match handlers instead of letting an older process overwrite newer state.
`MatchInit` fails closed when an active round's checkpoint is missing, unsupported, malformed, or
concurrently owned. Terminal-result commit deletes the checkpoint in the same transaction, and
lobby-closing abort deletes it in the abort transaction.

After Answer Check, the match builds deterministic canonical result bytes, inserts participant and
discovery evidence plus the initial result revision in one serializable transaction, and only then
moves the round to `completed`. The revision stores the exact canonical UTF-8 JSON bytes and their
database-verified SHA-256. Every evidence and revision identifier is deterministically derived as a
UUIDv7 so an ambiguous database retry resolves to the same committed result. Hider survival duration
is measured from the authoritative Hunting start rather than including preparation or hiding time.
The completed snapshot includes the durable local result revision ID.

An empty lobby aborts its active nonterminal round transactionally after any reconnect
reservations expire.

The runtime opens the application connection from `HC_NAKAMA_DATABASE_URL`. Production supplies a
dedicated login granted membership in the `hc_nakama` group role. Nakama's injected `*sql.DB`
continues to point only at Nakama's internal database and is never used for application schemas.

The remaining future RPCs stay registered as explicit `feature_not_ready` stubs until their cards
replace them with authoritative behavior.

The repository smoke command starts disposable application and Nakama databases, seeds two
short-lived real API sessions plus the official Neon Service Arcade release, and exercises the complete
bridge, host migration, nomination, server-only role assignment, round creation, same-assertion
replay denial, non-bridge authentication denial, server-timed Casual phases, rejected forged
outcomes, humanoid avatar relay, a mid-round Hider reconnect with state restoration, a mid-round
Nakama process restart with private-state and score-cadence recovery, authoritative discovery,
Answer Check scoring, and a terminal Hunter win without printing credentials:

```bash
npm run realtime:smoke
```

Nakama's WebSocket protocol reports the intentional RPC runtime exception as realtime code `7`
while preserving the `feature_not_ready` message; HTTP RPC callers receive gRPC `UNIMPLEMENTED`.
