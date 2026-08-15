# Hive Chameleon — Non-Functional Requirements

- **Status:** Initial implementation baseline
- **Scope:** P0 vertical slice and the P1 services that share its foundation
- **Related documents:** [Architecture and API design](./architecture/architecture-and-api-design.md),
  [Hive-layer design](./Hive-Layer-Design.md), and
  [data model](./data-model/data-model.md)

## 1. Purpose

These requirements define the minimum security, capacity, recoverability, environment, and
delivery posture for the first deployable product. They are measurable acceptance targets, not a
detailed production topology or operations runbook. Exact Hetzner server shapes, locations,
network layout, and the production custody provider remain separate deployment decisions.

## 2. Security baseline

1. All public HTTP, WebSocket, object-delivery, wallet callback, and internal cross-host traffic
   uses TLS. Databases, Redis, Nakama administration, metrics, and container control ports are not
   exposed directly to the public internet.
2. Development, staging, and production use distinct databases, buckets, service identities,
   signing accounts, sponsor credentials, and encryption/secrets scopes. Production data and
   secrets are never copied into a lower environment.
3. Runtime secrets are injected through an approved secret boundary with least-privilege access,
   rotation, and an owner. They are not committed to Git, built into Unity/WebGL artifacts, stored
   in PostgreSQL domain rows, printed in logs, or made available to ordinary CI jobs.
   The local WebGL development build is credential-neutral. A localhost-only launcher supplies
   replaceable, short-lived client credentials to the served page at runtime; neither the launcher
   output nor the resulting development build may be committed, published, or promoted.
4. Hive player keys, service-account keys, raw signup codes, and custody-provider credentials stay
   within their isolated boundaries. The general API, Unity client, Nakama runtime, and CI system
   receive no raw signing key. Production custody must pass the provider gate in the
   [integration register](./integrations/third-party-integration-register.md).
5. Authentication enforces nonce, origin/audience, expiry, replay prevention, one active device,
   rotating refresh credentials, and server-side revocation. Authorization follows the
   [roles and permissions model](./roles-and-permissions.md) and is rechecked at the service that
   owns the mutation.
6. Rate limits cover login challenges, OIDC callbacks, username checks, session minting, sponsor
   requests, Hive intents, uploads, lobby commands, payments, and administrative actions. Limits
   are environment configuration and fail closed when their authoritative state is unavailable.
7. Security-relevant actions produce structured audit events with actor/service identity,
   correlation ID, target, decision, reason, and timestamp, but no secrets or sensitive payloads.
   Production security audit records are retained for at least 180 days.
8. Dependencies and container bases are version-pinned and lockfiles are committed. CI performs
   dependency review, secret scanning, static analysis, and an SBOM/container vulnerability scan;
   unresolved critical vulnerabilities block production promotion.

## 3. Privacy and immutable-Hive-record compliance

### 3.1 No personal or doxxing data on-chain

On-chain payloads contain only the fields approved by the product and Hive-layer protocols, such as
the public Hive username and the ownership, payment, account, or creator facts required by that
protocol. They must not
contain email addresses, Google issuer/subject values, IP addresses, device or browser
fingerprints, KYC or identity-verification attributes/documents, access tokens, session
identifiers, private lobby data, free-form support text, or other personal/doxxing material.

Every new or changed on-chain schema requires a field-level privacy review before deployment.
Logging or hashing a prohibited value does not make it acceptable for publication.

### 3.2 Permanent Hive-record notice

Terms of Service and the relevant confirmation flow must state plainly that a player-authorized
Hive action creates a public, permanent record that is not erasable by an off-chain deletion
request. The confirmation is shown in the context of the action being authorized.

An off-chain deletion or account-support workflow may remove or restrict data that the platform
controls, subject to the approved retention policy, but it must never claim to delete, rewrite, or
hide an irreversible Hive record. Product and support UI must preserve that distinction.

## 4. Capacity and performance targets

The first production-shaped load test uses this MVP profile:

| Measure | Initial target |
| --- | --- |
| Concurrent authenticated players | 100 |
| Simultaneous full active matches | 10, at up to 10 players each |
| Simultaneously open lobby lifecycles | 20 |
| Non-Hive HTTP reads | p95 at or below 300 ms from the selected EU region |
| Durable command acceptance | p95 at or below 500 ms before asynchronous external work |
| Client rendering | At least 30 FPS at 1080p low on the agreed ordinary-laptop baseline |
| Normal-match reconnect window | 60 seconds, preserving the server-authorized outcome |

External wallet approval, Hive inclusion/irreversibility, sponsor work, object upload, and payment
settlement are excluded from the synchronous HTTP targets and expose explicit asynchronous state.
No active match waits on those dependencies.

The vertical slice starts without database partitioning or read replicas. Scale out Nakama nodes,
API/worker replicas, and connection pools independently when a load test reaches 70% sustained CPU
or memory, database p95 exceeds its target, or queue age breaches its operational threshold.
Partitioning, replicas, a dedicated HAF service, and a CDN require measured evidence rather than
being added pre-emptively.

## 5. Availability and degradation

- The initial production operational objective is 99.5% monthly availability for the public API
  and realtime entry path, excluding announced maintenance. This is an engineering objective, not
  a customer SLA.
- A Hive, sponsor, custody, HAF, or object-storage outage pauses only the actions that require that
  dependency. Active matches continue when the authoritative Nakama/PostgreSQL commit path is
  safe, and durable outboxes retain retryable work.
- Health endpoints distinguish process liveness, dependency readiness, and degraded external
  providers. A service must not report ready when it cannot safely accept durable work.
- All externally visible retries are idempotent. Uncertain external success is reconciled by a
  stable identifier or authoritative read before another side effect is attempted.

## 6. Environments and Hetzner posture

| Environment | Purpose | Hive/network policy | Data and access |
| --- | --- | --- | --- |
| Local | Fast development and deterministic tests | Mock adapters or an approved test network; never production signers | Docker services and disposable data |
| Development | Shared integration | Approved Hive test network/devnet where available | Development-only identities, DB, Redis, buckets, and secrets |
| Staging | Production-shaped release candidate and restore/load tests | Test network for writes; explicitly allow-listed mainnet reads only | Isolated staging project/data and non-production signers |
| Production | Real users and value-bearing operations | Hive mainnet and production providers only | Protected Hetzner project, production-only identities and secrets |

Hetzner Cloud is the selected compute/network host and Hetzner Object Storage is the selected MVP
asset store. Workloads use private networking and firewall allow-lists where supported. Direct
HTTPS or short-lived presigned delivery is used initially; no external CDN is required until
measurements justify one. The deployment card must still choose the EU location, server shape,
ingress, database placement, and failure-domain layout.

## 7. Backup and recovery

1. PostgreSQL uses encrypted daily base backups plus continuous WAL archiving or an equivalent
   mechanism. The target is **RPO <= 15 minutes** and **RTO <= 4 hours** for the application
   database.
2. Backups are encrypted with credentials distinct from the database runtime credential, retained
   for 30 days, and stored outside the primary server's failure domain. Before real-value P1
   flows, at least one recoverable copy must survive loss of the primary Hetzner project/location.
3. A staging restore is exercised monthly and before a migration with material data-loss risk.
   Restore evidence records the backup ID, timestamps, integrity result, achieved RPO/RTO, and
   responsible operator without exposing data or secrets.
4. Redis and live Nakama match memory are ephemeral and are not treated as durable backups.
   PostgreSQL terminal commits, Git, immutable build artifacts, and object hashes remain the
   recovery sources.
5. Object assets use immutable/versioned keys and recorded SHA-256 hashes. Lifecycle deletion is
   policy-driven; published collectible metadata cannot rely on an object scheduled for removal.

## 8. CI/CD and release controls

Pull requests run the applicable TypeScript lint/typecheck/tests, Go formatting/vet/tests, DBML
and migration validation, OpenAPI validation, secret/dependency scans, and Unity compile/build
checks when a licensed Unity runner is available. Required checks must pass before merge.

Build once and promote the same content-addressed artifacts through development, staging, and
production. Staging deployment and smoke tests precede a manually approved production promotion.
Production deployments use protected GitHub environments and narrowly scoped deployment
credentials; CI never receives a Hive signing key, custody key, sponsor credential, or database
superuser credential.

Database migrations are reviewed, forward-compatible with the currently deployed application,
and executed as a distinct release step. A failed migration stops promotion. Rollback uses a
tested application/database recovery plan rather than an unreviewed destructive down migration.

## 9. Observability and acceptance

Structured logs, metrics, and traces share correlation IDs across NestJS, Nakama, workers, and
external-operation records. Dashboards cover request latency/error rate, active sockets/matches,
database pool/queries, queue age, Hive finality lag, sponsor/custody health, RC reserves, backup
age, and deployment version. Alerts must identify an owner and a user-visible impact.

This baseline is satisfied when the production-shaped stack passes the stated load profile,
backup restore meets RPO/RTO, environment isolation is demonstrated, CI enforces the release
gates, and privacy plus irreversible-action confirmations are present in the approved product flow.
