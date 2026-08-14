# Hive Chameleon

Hive Chameleon is a 3D multiplayer camouflage and hide-and-seek game that uses Hive for
identity, rewards, and selected permanent game facts. This repository is the implementation
workspace for the Unity client, NestJS product API, Nakama authoritative runtime, Hive gateway,
and HAF projection worker.

The product and architecture decisions live in [`docs/`](docs/). Implementation starts from the
goal-based [roadmap](docs/implementation-roadmap.md).

## Prerequisites

- Node.js 24 and npm 11
- Go 1.26.3 or newer for source checks; use the pinned plugin-builder image for deployable Nakama
  modules
- Docker 29 or newer
- Unity 6.3 LTS, editor `6000.3.18f1`, with the required desktop and WebGL build-support modules

## Quick start

```bash
npm ci
npm run authoritative:start -- --clients 2
```

This starts the migrated PostgreSQL database, API, Nakama, and two authenticated local client
identities. Open [`clients/unity`](clients/unity/) in the pinned Unity editor and press Play. See
the [local authoritative multiplayer runbook](docs/local-authoritative-development.md) for client
switching, logs, shutdown, and optional simultaneous WebGL clients.

Run the repository checks separately with `npm run verify`.

Authentication and Google-to-Hive provisioning configuration is documented in
[`apps/api/README.md`](apps/api/README.md). The API intentionally fails closed for durable identity
operations when PostgreSQL or an approved external provider is not configured.

Build the Nakama module with the runtime-compatible toolchain:

```bash
docker build -t hive-chameleon-nakama:dev runtime/nakama
```

For optional browser-based multi-client testing, build one credential-neutral player and serve
distinct Client 1…10 sessions with:

```bash
npm run authoritative:webgl -- --clients 2
```

The generated artifact contains no embedded credential. The localhost launcher supplies a
different short-lived session at each client URL. It never falls back to a simulated round. The
live Hetzner deployment serves a release build at
[`https://hive-signer.cloverapis.xyz/game/`](https://hive-signer.cloverapis.xyz/game/); every
browser obtains an isolated, revocable guest session before Unity starts. See the
[Hetzner live-game runbook](infra/hetzner/README.md).

## Repository layout

| Path                    | Responsibility                                                |
| ----------------------- | ------------------------------------------------------------- |
| `apps/api`              | NestJS product API and scoped Nakama session issuance         |
| `clients/unity`         | Unity desktop and WebGL client                                |
| `runtime/nakama`        | Authoritative Nakama Go runtime module                        |
| `packages/hive-gateway` | Hive protocol boundary and isolated signing adapters          |
| `workers/haf-projector` | Fork-aware HAF event projection                               |
| `docs`                  | Product, architecture, security, data, and delivery decisions |

Do not commit credentials or private keys. Copy future `.env.example` files locally and inject
production secrets through the deployment environment.
