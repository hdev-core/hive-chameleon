# Chameleon — Deployment & Infrastructure Guide

Infra reference for **hive-chameleon** — the most infrastructure-rich project in the cohort:
a **Unity game client** (WebGL + desktop) backed by a TypeScript (NestJS) + **Go/Nakama workers** +
**Postgres** monorepo (`apps/ workers/ runtime/ infra/`, Dockerised).

**Your team**

- **Mohammad Ibrahim** — currently sole owner: architecture, data model, auth/identity, Hive
  layer, KMS signing POC, and the infra. (Lighter hand-holding here — you're already ahead on infra.)

---

## 1. Your stack

| Layer             | What you use                                                         | Where it runs                                                                                                     |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Game client       | **Unity** — WebGL (browser) + desktop (Win/macOS/Linux)              | WebGL showcase → Vercel static hosting; production assets → Hetzner Object Storage; desktop → downloadable builds |
| API               | NestJS (TypeScript)                                                  | **always-on** → local now, **Hetzner** later                                                                      |
| Realtime          | Nakama (Go)                                                          | **always-on** → local now, **Hetzner** later                                                                      |
| Workers / runtime | Hive gateway, HAF projector, publishers                              | **always-on** → local now, **Hetzner** later                                                                      |
| Database          | Postgres (heavy PL/pgSQL and ordered SQL migrations)                 | **Hetzner**, isolated per environment                                                                             |
| Signing           | secp256k1 via managed KMS/HSM                                        | isolated custody boundary — see note below                                                                        |
| Auth              | Keychain (WebGL) + HiveAuth (desktop) + custodial Google provisioner | Hive-native, **not** Supabase Auth                                                                                |

Two things make you different from the other cohort projects:

1. **Your client is Unity, not a React/Vercel web app** — it builds to WebGL (static files) + native
   desktop binaries, so the cohort "Vercel + `deploy.yml`" flow does **not** apply to it (see §3).
2. **You're backend-heavy with persistent services** (NestJS, Nakama, Go workers) that can't run on
   serverless — given your `infra/` + `Dockerfile`, a **Docker deploy on Hetzner** is their home (see §4).

---

## 2. "I can't deploy / connect X" — how access works

Connecting an external static host to a repo in the **`hdev-core`** org needs an **org owner
(Dr. Mohammad)** to authorize that service's GitHub app. The current WebGL showcase instead uses a
manual Vercel CLI deployment, so it does not require repository-wide Vercel app access.

---

## 3. Client → Unity builds (WebGL + desktop)

Your Unity client is **not** a React/Vercel app, so the cohort `deploy.yml`/`preview.yml` (built for
Vite/React) don't apply. Instead:

- **WebGL (browser):** Unity exports static files (`Build/` + `index.html`). The current showcase is
  deployed manually to **Vercel**; production asset delivery remains **Hetzner Object Storage** as
  selected by the NFR. No application or signing runtime executes on Vercel.
- **Desktop (Win/macOS/Linux):** ship as **downloadable builds** (e.g. GitHub Releases + a download
  page) — these are distributed binaries, not web-hosted.
- **Builds/CI:** Unity WebGL + desktop builds need a **licensed Unity CI runner** (e.g. game-ci) — set
  this up before staging promotion (it's already on your roadmap's decision gates). Your PR CI still
  runs the TS/Go/schema/OpenAPI checks; the Unity compile/build check runs when the licensed runner is available.
- _If_ you add a separate TS web portal under `apps/` (admin/landing), that one **can** use the
  standard Vercel + Actions method — but the game client itself follows the above.

Build and deploy the credential-free showcase from the repository root:

```bash
npm run unity:webgl:build
npm run unity:webgl:deploy
```

The build script removes all development realtime credentials before invoking Unity. The deploy
script refuses to continue unless the expected WebGL files exist and the Vercel CLI is authenticated.
The current production alias is <https://hive-chameleon.vercel.app>.

## 3b. Database → Postgres

The approved and implemented baseline is PostgreSQL on Hetzner, using the repository's ordered SQL
migrations, database invariants, and least-privilege workload roles. Keep connection strings in the
environment secret store and isolate databases and credentials per environment. Introducing Prisma
or Supabase would be a new architecture decision, not a deployment shortcut.

Auth stays Hive-native; canonical records go **on-chain**, Postgres is the off-chain mirror.

---

## 4. Your always-on services (Go workers + runtime)

Persistent processes — Vercel/Supabase can't host them.

- **While building:** run locally via Docker (`docker compose up`).
- **For a live demo / staging:** deploy the Dockerised workers to **our Hetzner box** (preferred,
  since you already have `infra/`), or Render background workers as a stopgap. Request when ready.

**KMS note:** your signing POC used **AWS KMS**. For hosting we're standardising on **Hetzner**, not
AWS — so before wiring KMS into production, check with Dr. Mohammad on the signing/HSM approach so we
don't take an AWS dependency for the running service. (POC on AWS is fine; production host is the question.)

---

## 5. Branch / PR / deploy flow

`feature/* → PR → develop → PR → main`. Never push straight to `main` or `develop`. Open a PR;
**Dr. Mohammad reviews and merges**. Comment on the Trello card with the PR link when moving it to
Code Review. CI runs for every PR and again after merges to `develop` and `main`. Until a licensed
Unity CI runner is configured, showcase WebGL builds and Vercel promotion remain an explicit manual
release step.

## 6. Secrets hygiene

Never commit `.env`, tokens, DB strings, or KMS creds. `.gitignore` `.env` + `.vercel`. CI secrets → GitHub repo secrets.
