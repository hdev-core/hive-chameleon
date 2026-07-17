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
npm run verify
npm run dev
```

The API then exposes:

- `GET http://localhost:3000/api/v1/health`
- `GET http://localhost:3000/api/v1/health/live`
- `GET http://localhost:3000/api/v1/health/ready`

Build the Nakama module with the runtime-compatible toolchain:

```bash
docker build -t hive-chameleon-nakama:dev runtime/nakama
```

Open [`clients/unity`](clients/unity/) in the pinned Unity editor. Its README documents desktop
and WebGL development builds.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/api` | NestJS product API and scoped Nakama session issuance |
| `clients/unity` | Unity desktop and WebGL client |
| `runtime/nakama` | Authoritative Nakama Go runtime module |
| `packages/hive-gateway` | Hive protocol boundary and isolated signing adapters |
| `workers/haf-projector` | Fork-aware HAF event projection |
| `docs` | Product, architecture, security, data, and delivery decisions |

Do not commit credentials or private keys. Copy future `.env.example` files locally and inject
production secrets through the deployment environment.
