# Chameleon — Deployment & Infrastructure Guide

Infra reference for **hive-chameleon** — the most infrastructure-rich project in the cohort:
a TypeScript + **Go workers** + **Postgres** monorepo (`apps/ workers/ runtime/ infra/`, Dockerised).

**Your team**
- **Mohammad Ibrahim** — currently sole owner: architecture, data model, auth/identity, Hive
  layer, KMS signing POC, and the infra. (Lighter hand-holding here — you're already ahead on infra.)

---

## 1. Your stack

| Layer | What you use | Where it runs |
|-------|--------------|---------------|
| Frontend | TypeScript app (`apps/*`) | **Vercel** |
| Database | Postgres (heavy PL/pgSQL) | **Supabase** *or* self-hosted (you have `infra/` + Dockerfile) |
| **Go workers / runtime** | your background services | **always-on** → local now, **Hetzner** later |
| Signing | secp256k1 via KMS/HSM | see note below |
| Auth | Keychain + custodial Google provisioner | Hive-native, **not** Supabase Auth |

You're **full-stack with persistent Go workers** — those can't run on Vercel (serverless). Given
you already have `infra/` + a `Dockerfile`, a **Docker deploy on our Hetzner box** is the natural
home for the workers when you go live (see §4).

---

## 2. "I can't deploy / connect X" — how access works

Connecting Supabase / Vercel / Render to a repo in the **`hdev-core`** org needs an **org owner
(Dr. Mohammad)** to authorize that service's GitHub app — you can't self-authorize. Request via your
DevOps card, naming the **service** scoped to **hive-chameleon only**. The Vercel *Actions* method
(§3A) needs no org app.

---

## 3. Frontend → Vercel

**A) GitHub Actions + token (recommended).** Create a Vercel project (set the Root Directory to your
web app inside `apps/`), add repo secrets `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`, add
`deploy.yml` + `preview.yml` (see `HOSTING_GUIDE.md`). Push to `main` → auto-deploy; each PR → preview.
**B)** Or the owner authorizes the Vercel app (scoped to hive-chameleon) and you import it.

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
