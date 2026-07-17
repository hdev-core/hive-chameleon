# PostgreSQL migrations

This directory contains the executable PostgreSQL 17 baseline for Hive Chameleon. The DBML file
in `docs/technical-specification/data-model/hive-chameleon.dbml` remains the ERD source; these
ordered SQL migrations add the PostgreSQL behavior that DBML cannot express.

The local stack pins PostgreSQL `17.7-bookworm` by multi-platform image digest and dbmate 2.34.1
by release tag. It creates only disposable local credentials. Production credentials, topology,
backups, and Hetzner placement are deployment concerns and must not copy these values.

## Clean migration test

From the repository root:

```bash
docker compose -f infra/postgres/compose.yaml down --volumes --remove-orphans
docker compose -f infra/postgres/compose.yaml up \
  --abort-on-container-exit \
  --exit-code-from schema-test \
  schema-test
docker compose -f infra/postgres/compose.yaml down --volumes --remove-orphans
```

The test applies every migration to an empty database, then verifies schema inventory, UUIDv7,
partial indexes, authorization approval/audit coupling, fork checkpoints, immutable evidence,
host consistency, terminal-round/revision behavior, accepted linear match corrections, and
cross-service database-role isolation.

## Workload roles

Production login identities receive exactly one NOLOGIN group role and use `SET ROLE` after
connecting. There is intentionally no generic worker role.

| Role | Mutable database surface |
| --- | --- |
| `hc_provisioning` | Pending identity, account-provisioning, custody-reference, claim, player, and session lifecycle |
| `hc_match_publisher` | Match publication requests, immutable-payload outbox lifecycle, and ordered publication membership |
| `hc_collectible_issuer` | Its own `collectible_issuer` transaction intents only |
| `hc_treasury` | Its own `treasury` transaction intents only; payout/payment plans are read-only |
| `hc_rc_support` | Its own `rc_support` transaction intents only; projected delegation evidence is read-only |
| `hc_projector` | Fork checkpoints, raw operations, and typed Hive projections |
| `hc_api`, `hc_nakama`, `hc_security_auditor` | Product API orchestration, authoritative match writes, and read-only audit evidence respectively |

Row-level policies bind shared official `transaction_intent` rows to the current database service
role. A service cannot create, see, or update another signer's intent. Application allow-lists and
isolated signer credentials remain mandatory; database grants are defense in depth.

For an inspectable development database:

```bash
docker compose -f infra/postgres/compose.yaml up -d postgres
docker compose -f infra/postgres/compose.yaml run --rm dbmate
```

The default host URL is:

```text
postgres://postgres:postgres@localhost:5433/hive_chameleon?sslmode=disable
```

Copy `.env.example` to `.env` only when a different local port is needed.

## Migration policy

- Migrations are forward-only, reviewed release artifacts. Recovery uses a tested backup and a
  forward repair, not an improvised destructive down migration.
- Run migrations as a distinct deployment step before application promotion. Runtime workloads
  use the NOLOGIN group roles established by the final migration through separate deployment
  login identities.
- Keep SQL schema-qualified and transactional. An operation needing `CREATE INDEX CONCURRENTLY`
  belongs in its own explicitly nontransactional migration.
- The application generates UUIDv7. PostgreSQL validates version/variant bits but does not invent
  domain IDs.
- Insert completed-round participants, discoveries, likes, the initial revision, and the initial
  publication request while the round is nonterminal; update the round to `completed` last in the
  same transaction. The deferred terminal-bundle trigger validates the committed aggregate.
- A fork replacement marks the old reversible checkpoint/operations `reverted`, then inserts the
  replacement branch. Irreversible rows cannot be reverted.
- Do not mutate a migration that has reached a shared environment. Update DBML and add a new
  migration instead.

## DBML validation

To validate relationship resolution without changing a committed migration:

```bash
NPM_CONFIG_CACHE=/tmp/npm-cache npx --yes --package @dbml/cli \
  dbml2sql docs/technical-specification/data-model/hive-chameleon.dbml \
  --postgres --out-file /tmp/hive-chameleon.sql
```

The generated SQL does not contain the partial indexes, triggers, extensions, role grants, or
other PostgreSQL-specific rules in the later migrations. It is a comparison aid, not a release
artifact by itself.
