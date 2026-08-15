# Local authoritative multiplayer

This is the normal local run path for Hive Chameleon. One command starts PostgreSQL, applies the
application migrations, builds and starts Nakama, builds and starts the API, and provisions up to
ten authenticated local client identities.

It does not create offline rounds, simulated players, or permanent Host/Guest identities. A
client becomes the lobby host only when the authoritative lobby says so, and host ownership can
migrate to another connected client.

## Prerequisites

- Node.js 24 and npm 11
- Docker Desktop with Docker Compose
- Unity `6000.3.18f1` for Editor or WebGL client testing

Install the repository dependencies once:

```bash
npm ci
```

### Bundled arena

Neon Service Arcade is bundled in the Unity project and is the only selectable arena. A clean
clone needs no Asset Store map download. The client and Nakama both pin content version `m2`,
authority geometry version `neon-service-arcade-authority-5`, and the matching geometry digest;
they fail closed if those identities disagree.

## Start the stack

From the repository root:

```bash
npm run authoritative:start -- --clients 2
```

The first run builds the API and Nakama image, starts both PostgreSQL databases, applies
migrations, and creates Client 1 and Client 2. Later runs reuse the local Docker volumes and
refresh the short-lived client access tokens. Ports are allocated locally and recorded in ignored
state, so fixed ports and hand-written environment files are unnecessary.

Open `clients/unity` in Unity, wait for compilation to finish, and press Play. The Editor uses the
selected client from the ignored local configuration. It will show the real online entry screen
and will not enter an arena until Nakama authorizes a lobby round.

Check the running services and client token expirations with:

```bash
npm run authoritative:status
```

If server or API source changed, rebuild and restart the services while keeping local data:

```bash
npm run authoritative:restart
```

## Client 1 through Client 10

“Provisioning clients” means creating distinct local player records, authenticated database
sessions, and short-lived access tokens. It does not assign game
roles and does not put those clients into a lobby. Any provisioned client may create a lobby, join
one, become host, lose host through migration, or receive a Hunter/Hider role from Nakama.

Provision or refresh any number of identities up to the ten-player lobby limit:

```bash
npm run authoritative:clients -- --count 5
```

Choose the identity used on the next Unity Editor Play session:

```bash
npm run authoritative:use -- --client 3
```

Alternatively, use **Hive Chameleon > Local Multiplayer > Use Client 1…10** inside Unity. Stop
Play mode before switching. One Unity Editor process represents one client at a time; the tooling
does not bypass Unity's project lock or launch duplicate Editors.

## Optional multi-client WebGL launcher

The WebGL launcher exists for simultaneous browser and automated visual testing. It creates one
credential-neutral development build, then serves that same build at a distinct URL for every
client:

```bash
npm run authoritative:webgl -- --clients 3
```

The command prints URLs ending in `/client/1/`, `/client/2/`, and `/client/3/`. Open any subset in
separate browser profiles or private windows. Each URL receives its own short-lived local session;
there is still only one compiled Unity artifact.

Reuse an existing WebGL build after client-only or server-only changes:

```bash
npm run authoritative:webgl -- --clients 3 --no-build
```

WebGL building needs the Unity Editor to be closed because Unity enforces a project lock. The
tooling deliberately leaves that decision to the developer. The local launcher configures the
exact API origin internally; CORS configuration is not involved in Unity Editor Play.

These WebGL URLs and their generated build are local development material. They do not implement
production login and must not be deployed.

## Logs and shutdown

Read recent redacted logs:

```bash
npm run authoritative:logs -- api
npm run authoritative:logs -- nakama
npm run authoritative:logs -- postgres
npm run authoritative:logs -- webgl
```

Stop the stack while preserving database volumes and local identities:

```bash
npm run authoritative:stop
```

Remove the services, Docker volumes, generated credentials, and cached state:

```bash
npm run authoritative:clean
```

Local credentials live only in ignored files under `.cache/authoritative-development/` and
`clients/unity/Library/HiveChameleon/`. They are written with owner-only permissions, are never
printed by normal commands, and must never be copied into commits, screenshots, tickets, or
deployed builds.

## Typical two-player check

1. Start with `npm run authoritative:start -- --clients 2`.
2. Use Client 1 in the Editor and Client 2 in the WebGL launcher, or open the two WebGL client
   URLs.
3. Let either client create a lobby.
4. Copy its lobby code into the other client and join.
5. Confirm both roster entries come from the server.
6. Start the round from whichever client currently holds the Host role.
7. Close that client and confirm Nakama migrates Host to the remaining client.

The labels Client 1 and Client 2 identify local authenticated sessions only; they never determine
which side of the game either player occupies.

## Cold reconnect check

Cold reconnect covers a browser refresh, Unity Play restart, or application restart where the old
Nakama session and in-memory lobby ID no longer exist. It is distinct from a brief socket reconnect
inside the same Unity process.

1. Start at least two clients, join one lobby, and begin a real round.
2. During `hiding` or `hunting`, refresh one WebGL tab or stop and immediately restart that client's
   Unity Play session. Do not click **LEAVE LOBBY**.
3. Within 60 seconds, the restarted client should automatically return to the same lobby and round.
   If automatic restoration was still resolving when the entry screen appeared, press **CONNECT**
   once.
4. Confirm its private role, Infection conversion state, ammunition, score eligibility, and outcome
   are unchanged. The client must not choose any of those values.
5. Repeat after waiting more than 60 seconds. The old round slot must not be restored or have its
   deadline extended by the request.

The authenticated API exposes only `GET /api/v1/me/reconnect` with the caller's lobby ID, deadline,
and restoration mode. It never exposes the round ID, role, score, other players, or private Nakama
checkpoint. A fresh realtime credential then calls `match.reconnect`; Nakama remains authoritative
for whether the reservation can be claimed.
