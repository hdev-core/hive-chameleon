# Hive Chameleon — Roles and Permissions

- **Status:** Initial authorization baseline
- **Scope:** Human product roles, resource-scoped capabilities, and non-human service identities
- **Related documents:** [Architecture and API design](./architecture/architecture-and-api-design.md),
  [Hive-layer design](./Hive-Layer-Design.md), and
  [non-functional requirements](./non-functional-requirements.md)

## 1. Authorization model

Hive Chameleon uses three separate concepts:

1. **Account state** determines whether an identity is pending onboarding, playable, under claim,
   or otherwise restricted.
2. **Platform roles** grant narrowly defined staff/operator permissions across resources.
3. **Resource capabilities** come from a relationship to one object, such as being the current
   lobby host or the creator of a map.

A Hive authority, Google identity, wallet provider, collectible, or token balance does not grant a
platform role. Clients may request actions but never assert their own role. NestJS and Nakama load
authoritative assignments and resource state, evaluate the action at the owning service, and deny
by default.

## 2. Human and resource-scoped roles

| Role/capability | Scope | How it is obtained | Primary permissions |
| --- | --- | --- | --- |
| Pending identity | One onboarding job | Successful Google OIDC before provisioning is ready | Complete disclosure, reserve/confirm a username, inspect the same provisioning operation; no gameplay or ordinary player API |
| Player | Own account | Verified direct-Hive login or completed Google-to-Hive provisioning | Play, manage own profile/settings/appearance, initiate own Hive actions, view permitted product data |
| Lobby host | One active lobby | Server assignment, transfer, or host migration | Configure/start the lobby, kick eligible members, transfer host, set supported round options |
| Map creator | Own maps/versions | Authenticated player creates a map record | Draft, upload, submit, revise, view review feedback, publish an approved showcase through own Hive authority |
| Content reviewer | Platform-wide content queue | Time-bounded assignment by a platform administrator | Inspect submitted map packages, approve/reject versions, record reviewer-facing and creator-facing reasons |
| Content moderator | Published/distributed content | Time-bounded assignment by a platform administrator | Suspend/remove/restore eligible content with a reason; cannot rewrite authorship or historical match references |
| Tournament operator | Official controlled tournaments | Assignment by a platform administrator | Configure and operate approved tournament formats, resolve operational states, submit a payout plan for policy validation |
| Support operator | Account/workflow support | Time-bounded assignment by a platform administrator | Inspect non-secret support state, revoke game sessions, retry explicitly safe idempotent workflows, record support notes/actions |
| Security auditor | Read-only operational scope | Time-bounded assignment by a platform administrator | Read authorization/security audit records and configuration evidence; no mutation or secret access |
| Platform administrator | Platform authorization/configuration | Two-person approved assignment | Assign/revoke staff roles, manage approved policy/configuration, resolve escalated moderation; no automatic signing or treasury access |

Community tournament organizer permissions remain deferred. A future organizer role cannot be
inferred from the current `community` data-model enum; it requires an approved product and money
movement policy first.

## 3. Permission matrix

“Own/scoped” means the actor must also satisfy the current resource relationship and lifecycle
rules. A blank or missing permission is denied.

| Action | Player | Lobby host | Map creator | Reviewer | Moderator | Tournament operator | Support | Auditor | Admin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Play and use own profile/settings | Own | Own | Own | Own | Own | Own | Own | Own | Own |
| Configure/start/kick/transfer a lobby | — | Scoped | — | — | — | — | — | — | Emergency termination only |
| Submit or revise a map | Own | — | Own | — | — | — | — | Read | — |
| Approve/reject a submitted map version | — | — | — | Scoped, never own submission | — | — | — | Read | Escalation only |
| Suspend/remove/restore distributed content | — | — | — | Recommend | Scoped | — | — | Read | Escalation only |
| Operate an approved tournament | Enter | — | — | — | — | Scoped | — | Read | Policy/config only |
| Revoke a game session or retry a safe workflow | Own session | — | — | — | — | — | Scoped | Read | Escalation only |
| Assign privileged platform roles | — | — | — | — | — | — | — | Read | Scoped, audited |
| Read security/authorization audit evidence | Own public history only | — | — | Own decisions | Own decisions | Own actions | Own actions | Read | Read |
| Sign with an official Hive service authority | — | — | — | — | — | — | — | — | — |

An administrator is not a universal data or action bypass. Administrative emergency operations
must be explicitly implemented, separately authorized, reasoned, and audited. There is no generic
“act as player,” arbitrary transaction, database-console, or signing-key permission.

## 4. Resource rules

### 4.1 Lobby host

Host capability is derived from the current open `game.lobby_host_assignment`, not a durable
global role or a client claim. It ends immediately on transfer, migration, or lobby closure.
The host cannot declare hits, roles, scores, match results, payments, account sanctions, or Hive
events. Nakama rechecks host ownership and lobby version for every host command.

### 4.2 Map creator and review

A creator controls drafts and new versions but cannot approve, distribute, suspend, or restore
their own submission. A reviewer cannot decide a submission they created or materially
contributed to. Review and moderation append decisions and lifecycle events; they do not mutate
the submitted package/hash or erase historical attribution.

### 4.3 Tournament operation

The operator manages the approved off-chain tournament lifecycle but never holds the treasury
key. Payouts are calculated from committed tournament state and passed as a bounded plan to the
isolated treasury policy/worker. Manual recipient, asset, or amount overrides require a new
reviewed plan rather than direct signing access.

### 4.4 Support

Support may revoke a compromised game session and resume a workflow only through its existing
idempotency/reconciliation contract. Support cannot select a Hive account from an email address,
change a player's Hive authorities or recovery account, reveal or export a key, bypass payment or
ownership evidence, or mark an unverified provisioning job complete.

## 5. Non-human service identities

Service identities are not assignable human roles and are never accepted from a client token.

| Service identity | Allowed responsibility | Explicitly excluded |
| --- | --- | --- |
| NestJS application | Product HTTP authorization and durable orchestration | Raw Hive/service keys, authoritative frame simulation |
| Nakama runtime | Lobby/match authority, presence, reconnect, terminal result production | Official Hive publication, treasury, account provisioning |
| Provisioning worker | Sponsor/custody orchestration and on-chain verification | Sponsor Hive key, match publication, treasury work |
| HAF projection worker | Fork-aware reads, validation, projection, irreversibility | Broadcasting or inventing chain effects |
| Match publisher | Approved match batch/correction/invalidation operations | Player, issuer, treasury, or sponsor actions |
| Collectible issuer | Approved issue/revoke events | Payments, player actions, match results |
| Treasury | Approved bounded payouts | Player debits, arbitrary recipients/assets/amounts |
| RC support | Approved later RC assistance/reclaim | Initial sponsored provisioning or unrelated Hive actions |
| Custody provider | Generate/sign/destroy only by opaque player-key policy | Product authorization or arbitrary transaction construction |
| Signup sponsor | Create the exact requested account and initial RC under contract | Product login, player custody, or any platform service role |

Each deployable identity has its own credential, database/network permissions, operation allow-list,
rate limits, and audit trail. Credentials are not interchangeable even when one operator owns
multiple deployments.

## 6. High-risk changes and separation of duties

The following production actions require two distinct authorized humans, or one initiator plus an
independent protected-environment approval:

- grant or extend `platform_administrator`, `security_auditor`, or treasury-policy authority;
- change a production signer account, custody policy, sponsor policy, or allowed Hive operation;
- approve a manual treasury payout or raise payout/recipient/asset limits;
- publish a match correction/invalidation outside a pre-approved automated reconciliation; and
- disable audit/security controls or perform a destructive production restore.

The initiating actor cannot approve the same change. Break-glass access is time-limited,
reasoned, alerted, and reviewed after use; it still does not expose a Hive private key.

## 7. Persistence and enforcement requirements

The data model persists platform-role assignments with role, player/staff identity, granting actor,
scope where applicable, validity interval, revocation, and reason. Resource roles continue to
derive from their domain tables. Every privileged allow/deny decision and role change produces an
append-only authorization audit event.

- NestJS guards enforce HTTP/product permissions and load current state rather than trusting JWT
  role claims for long-lived authorization.
- Nakama enforces lobby/match capabilities from runtime state and server identity.
- Workers authenticate service-to-service requests and enforce their operation-specific policy.
- PostgreSQL roles provide defense in depth but are not the product authorization interface.
- Open sessions lose privileged access immediately after role revocation; short-lived cached role
  data must be invalidated or expire within five minutes.

Authorization tests cover every permission row, ownership/scope mismatch, revoked/expired role,
self-review attempt, client-forged role, service-identity crossover, and high-risk approval rule.
