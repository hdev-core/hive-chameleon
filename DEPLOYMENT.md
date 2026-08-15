# Chameleon — Deployment & Infrastructure Guide

Infra reference for **hive-chameleon** — the most infrastructure-rich project in the cohort:
a **Unity game client** (WebGL + desktop) backed by a TypeScript (NestJS) + **Go/Nakama workers** +
**Postgres** monorepo (`apps/ workers/ runtime/ infra/`, Dockerised).

**Your team**

- **Mohammad Ibrahim** — currently sole owner: architecture, data model, auth/identity, Hive
  layer, KMS signing POC, and the infra. (Lighter hand-holding here — you're already ahead on infra.)

---

## 1. Your stack

| Layer             | What you use                                                              | Where it runs                                                                      |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Game client       | **Unity** — WebGL (browser) + desktop (Win/macOS/Linux)                   | Local test builds; release WebGL → Hetzner `/game/`; desktop → downloadable builds |
| API               | NestJS (TypeScript)                                                       | **always-on** → local now, **Hetzner** later                                       |
| Realtime          | Nakama (Go)                                                               | **always-on** → local now, **Hetzner** later                                       |
| Workers / runtime | Hive gateway, HAF projector, provisioning/collectible/treasury/RC workers | **always-on** → local now, **Hetzner** later                                       |
| Database          | Postgres (heavy PL/pgSQL and ordered SQL migrations)                      | **Hetzner**, isolated per environment                                              |
| Signing           | secp256k1 via managed KMS/HSM                                             | isolated custody boundary — see note below                                         |
| Auth              | Keychain (WebGL) + HiveAuth (desktop) + custodial Google provisioner      | Hive-native, **not** Supabase Auth                                                 |

Two things make you different from the other cohort projects:

1. **Your client is Unity, not a React/Vercel web app** — it builds to WebGL (static files) + native
   desktop binaries, so the cohort "Vercel + `deploy.yml`" flow does **not** apply to it (see §3).
2. **You're backend-heavy with persistent services** (NestJS, Nakama, Go workers) that can't run on
   serverless — given your `infra/` + `Dockerfile`, a **Docker deploy on Hetzner** is their home (see §4).

---

## 2. "I can't deploy / connect X" — how access works

The Unity game uses a credential-neutral release build on Hetzner. The public page obtains one
isolated guest identity and revocable session per browser before starting Unity; neither access nor
refresh credentials are embedded in the static artifact.

---

## 3. Client → Unity builds (WebGL + desktop)

Your Unity client is **not** a React/Vercel app, so the cohort `deploy.yml`/`preview.yml` (built for
Vite/React) don't apply. Instead:

- **WebGL (browser):** Unity exports static files (`Build/` + `index.html`). Local multiplayer
  builds connect to the development stack. The live release is served by Nginx at `/game/` on the
  Hetzner host and reaches the TLS-proxied API and Nakama services on the same origin.
- **Desktop (Win/macOS/Linux):** ship as **downloadable builds** (e.g. GitHub Releases + a download
  page) — these are distributed binaries, not web-hosted.
- **Builds/CI:** Unity WebGL + desktop builds need a **licensed Unity CI runner** (e.g. game-ci) — set
  this up before staging promotion (it's already on your roadmap's decision gates). Your PR CI still
  runs the TS/Go/schema/OpenAPI checks; the Unity compile/build check runs when the licensed runner is available.
- _If_ you add a separate TS web portal under `apps/` (admin/landing), that one **can** use the
  standard Vercel + Actions method — but the game client itself follows the above.

Start the authoritative local stack and build the optional browser clients from the repository
root:

```bash
npm run authoritative:start -- --clients 2
npm run authoritative:webgl -- --clients 2
```

The client has no offline, preview, synthetic-player, or simulated-round mode. The build script
creates one credential-neutral artifact; the localhost launcher supplies a distinct short-lived
session to each local client URL. For the public artifact, the page requests one environment-gated
guest session per browser before Unity launches. See
[`docs/local-authoritative-development.md`](docs/local-authoritative-development.md) and
[`infra/hetzner/README.md`](infra/hetzner/README.md).

## 3b. Database → Postgres

The approved and implemented baseline is PostgreSQL on Hetzner, using the repository's ordered SQL
migrations, database invariants, and least-privilege workload roles. Keep connection strings in the
environment secret store and isolate databases and credentials per environment. Introducing Prisma
or Supabase would be a new architecture decision, not a deployment shortcut.

Auth stays Hive-native. PostgreSQL is authoritative for accounts, gameplay, terminal results, and
application state; Hive-dependent player actions and service events retain their own verified Hive
evidence.

---

## 4. Your always-on services (Go workers + runtime)

Persistent processes — Vercel/Supabase can't host them.

- **While building:** run locally via Docker (`docker compose up`).
- **For a live demo / staging:** deploy the Dockerised workers to **our Hetzner box** (preferred,
  since you already have `infra/`), or Render background workers as a stopgap. Request when ready.

**Signing note:** production signing remains behind the provider-neutral signer boundary. Hetzner
hosts the application workloads; the approved managed HSM/KMS provider, key policies, and network
path must pass the security decision gate before production. No AWS runtime dependency is assumed.

---

## 5. Branch / PR / deploy flow

`feature/* → PR → develop → PR → main`. Never push straight to `main` or `develop`. Open a PR;
**Dr. Mohammad reviews and merges**. Comment on the Trello card with the PR link when moving it to
Code Review. CI runs for every PR and again after merges to `develop` and `main`. Until a licensed
Unity CI runner is configured, Unity release builds and deployment remain a manually verified
promotion gate. There is no Vercel showcase-promotion path; approved WebGL artifacts are served by
the Hetzner Nginx deployment.

## 6. Secrets hygiene

Never commit `.env`, tokens, DB strings, or KMS creds. `.gitignore` `.env` + `.vercel`. CI secrets → GitHub repo secrets.
