# Chameleon — Deployment & Infrastructure Guide

Infra reference for **hive-chameleon** — the most infrastructure-rich project in the cohort:
a **Unity game client** (WebGL + desktop) backed by a TypeScript (NestJS) + **Go/Nakama workers** +
**Postgres** monorepo (`apps/ workers/ runtime/ infra/`, Dockerised).

**Your team**
- **Mohammad Ibrahim** — currently sole owner: architecture, data model, auth/identity, Hive
  layer, KMS signing POC, and the infra. (Lighter hand-holding here — you're already ahead on infra.)

---

## 1. Your stack

| Layer | What you use | Where it runs |
|-------|--------------|---------------|
| Game client | **Unity** — WebGL (browser) + desktop (Win/macOS/Linux) | WebGL → static host (Hetzner Object Storage or a static CDN); desktop → downloadable builds (not web-hosted) |
| API | NestJS (TypeScript) | **always-on** → local now, **Hetzner** later |
| Realtime | Nakama (Go) | **always-on** → local now, **Hetzner** later |
| Workers / runtime | Hive gateway, HAF projector, publishers | **always-on** → local now, **Hetzner** later |
| Database | Postgres (heavy PL/pgSQL) | **Supabase** *or* self-hosted (you have `infra/` + Dockerfile) |
| Signing | secp256k1 via managed KMS/HSM | isolated custody boundary — see note below |
| Auth | Keychain (WebGL) + HiveAuth (desktop) + custodial Google provisioner | Hive-native, **not** Supabase Auth |

Two things make you different from the other cohort projects:
1. **Your client is Unity, not a React/Vercel web app** — it builds to WebGL (static files) + native
   desktop binaries, so the cohort "Vercel + `deploy.yml`" flow does **not** apply to it (see §3).
2. **You're backend-heavy with persistent services** (NestJS, Nakama, Go workers) that can't run on
   serverless — given your `infra/` + `Dockerfile`, a **Docker deploy on Hetzner** is their home (see §4).

---

## 2. "I can't deploy / connect X" — how access works

Connecting Supabase / a static host / Render to a repo in the **`hdev-core`** org needs an **org owner
(Dr. Mohammad)** to authorize that service's GitHub app — you can't self-authorize. Request via your
DevOps card, naming the **service** scoped to **hive-chameleon only**.

---

## 3. Client → Unity builds (WebGL + desktop)

Your Unity client is **not** a React/Vercel app, so the cohort `deploy.yml`/`preview.yml` (built for
Vite/React) don't apply. Instead:

- **WebGL (browser):** Unity exports static files (`Build/` + `index.html`). Serve them from **Hetzner
  Object Storage** (matches your NFR asset store) over HTTPS/presigned delivery, or any static host.
  No serverless runtime involved.
- **Desktop (Win/macOS/Linux):** ship as **downloadable builds** (e.g. GitHub Releases + a download
  page) — these are distributed binaries, not web-hosted.
- **Builds/CI:** Unity WebGL + desktop builds need a **licensed Unity CI runner** (e.g. game-ci) — set
  this up before staging promotion (it's already on your roadmap's decision gates). Your PR CI still
  runs the TS/Go/schema/OpenAPI checks; the Unity compile/build check runs when the licensed runner is available.
- *If* you add a separate TS web portal under `apps/` (admin/landing), that one **can** use the
  standard Vercel + Actions method — but the game client itself follows the above.

## 3b. Database → Postgres

You have heavy PL/pgSQL. Two paths:
- **Supabase** (managed) — same as the rest of the cohort; use the pooled `DATABASE_URL`
  (`:6543?pgbouncer=true`) + direct `DIRECT_URL` (`:5432`) split if you drive it from Prisma.
- **Self-hosted Postgres** on the Hetzner box, if your `infra/` already provisions it — fine, but
  keep the connection strings in `.env` / secrets, never committed.

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

`feature/* → PR → develop → PR → main → auto-deploys`. Never push straight to `main`/`develop`.
Open a PR; **Dr. Mohammad reviews & merges**. Comment on your card + link the PR when you move it.

## 6. Secrets hygiene
Never commit `.env`, tokens, DB strings, or KMS creds. `.gitignore` `.env` + `.vercel`. CI secrets → GitHub repo secrets.
