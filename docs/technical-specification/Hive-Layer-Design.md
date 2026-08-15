# Hive Layer Design

## 1. Scope and authority

Hive Chameleon uses Hive for durable account identity, player-authorized social and payment
operations, collectible ownership evidence, account provisioning, recovery, and resource-credit
support. Real-time simulation, lobby state, scoring, terminal results, revisions, and detailed game
history remain authoritative in Nakama and PostgreSQL.

The design follows these rules:

- A Unity client never holds an official service credential.
- A player operation requires current player authorization and the authority appropriate to that
  operation.
- A service operation uses a dedicated account, database role, allow-list policy, and isolated
  signer.
- The general API and gameplay processes do not receive raw Hive private keys.
- Reversible Hive evidence does not become final product state before the last irreversible block.
- Live gameplay does not wait for Hive availability.

## 2. Component boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Unity client | Interaction, presentation, wallet handoff, explicit confirmations | Authority over game results or official service keys |
| NestJS API | Product sessions, identity orchestration, player authorization, transaction intents | Real-time simulation or private-key material |
| Nakama runtime | Lobby/match authority, reconnect, scoring, exact terminal-result commit | Hive signing or custody |
| Hive Gateway | Canonical operations, WAX serialization, policy validation, signer requests | Product authorization decisions or raw keys |
| Provisioning worker | Google-to-Hive account creation, initial RC, custody lifecycle | Gameplay, commerce fulfillment, treasury actions |
| Collectible issuer | Approved issue/revoke commands | Player, sponsor, treasury, or provisioning actions |
| Treasury worker | Approved tournament entry/payout transfer workflow | Winner calculation or player custody |
| RC-support worker | Approved delegation/reclaim workflow | Account ownership or gameplay |
| HAF projector | Fork-aware raw evidence and irreversible application projections | Creating chain operations or inventing business state |

Each production workload receives a distinct login mapped to one NOLOGIN PostgreSQL group role.
Shared tables such as `hive_projection.transaction_intent` use row-level policy so one service
cannot read or mutate another service's intent.

## 3. Player identity

### 3.1 Direct Hive login

The API issues a short-lived challenge bound to the lowercase Hive username, audience, device
session, nonce, issuance time, and expiry. The player signs with current posting authority through
an approved provider. The server resolves current public authority from Hive, verifies the
signature, consumes the challenge once, and creates a revocable product session.

The application stores the Hive username and public verification evidence. It never receives the
player's private key or wallet recovery material.

### 3.2 Google provisioning

A verified Google issuer/subject maps to one opaque external identity. Email addresses and Google
tokens are not identity keys in the product database. The player confirms a permanent available
Hive username before the provisioning job advances.

The provisioning worker then:

1. generates owner, active, posting, and memo keys through the configured custody provider;
2. submits account creation through the approved signup sponsor;
3. observes the account and expected public authorities on Hive;
4. verifies initial RC support;
5. links the resulting player and issues a playable product session.

The operation is idempotent by external identity and provisioning job. A retry resumes the same
job and username rather than creating another player.

### 3.3 Claim and recovery

Claiming transfers owner, active, posting, and memo authority to player-supplied public keys. The
owner-authorized authority operations are prepared canonically and require explicit player
approval. Custodial signing is disabled and custody key destruction is evidenced before the claim
can advance. Completion waits for the recovery-account transition and the corresponding
`changed_recovery_account` evidence.

## 4. Authorization and signing

Hive Gateway receives an already-authorized intent and validates:

- authorization mode (`external_wallet`, `custodial_player`, or `official_service`);
- required Hive authority;
- account, role, public key, signer-key reference, and policy version;
- canonical operation bytes and hash;
- idempotency binding and transaction expiry.

Self-custodial operations leave the platform for the player's wallet to sign. Custodial player
operations go to the per-player custody boundary only after a current session and explicit action
have been verified. Official events go to a separate service signer. Signers reconstruct and
compare the operation before signing; callers cannot provide arbitrary transaction bytes under a
trusted role.

An idempotency key is durably bound to the exact canonical operation and signing request. Once
provider invocation may have begun, an uncertain attempt is fenced for operator reconciliation
rather than silently signed again.

## 5. Collectibles

The first official application event family is:

- `collectible_issued`
- `collectible_revoked`

Both use a versioned canonical JSON envelope under the `hive.chameleon` custom-JSON namespace.
Issue events include stable UUIDv7 identity, definition code, kind, owner, issuer, reason, metadata
URI/hash, and optional payment reference. Revocation references the original issue event and
collectible.

Only the configured collectible issuer posting authority can submit these events. The commerce or
achievement domain authorizes the command before it reaches the issuer. The issuer validates the
local definition and immutable metadata, then journals the exact operation before isolated
signing.

HAF materializes ownership only when the accepted issue is irreversible and agrees with the local
definition, owner, and optional payment. Revocation can affect only a finalized matching issue.
The local ownership cache is reconstructible from accepted chain evidence.

## 6. Payments and tournaments

HIVE/HBD transfers and supported Hive-Engine transfers retain their native transaction evidence.
The API creates a bounded intent with expected asset, amount, recipient, memo/reference, player,
and expiry. Fulfillment occurs only after the observed irreversible transfer matches those terms.

Tournament brackets, eligibility, winner calculation, and scoring are product data in PostgreSQL.
Entry payments and payouts use their native transfers. The treasury worker executes only an
approved bounded payout plan and cannot calculate or rewrite tournament winners.

Refunds, cancellation behavior, token allow-lists, and community-organized treasury policy remain
explicit product decisions; no generic transfer is treated as a valid purchase or payout merely
because it mentions the application.

## 7. Community and map references

Player-authorized posts and votes use the player's own posting authority. The application may
project approved community-post references and current vote evidence for discovery and moderation.
Map packages, version manifests, moderation state, licenses, and distribution artifacts remain in
the content system and object storage. Hive references can provide attribution or discovery but do
not replace the authoritative package/version contract.

## 8. HAF projection and finality

The projector reads HAfAH/Hive sources into:

- fork-aware block checkpoints;
- raw application operation evidence, including rejected evidence and reason codes;
- irreversible collectible, payment, account, and community projections needed by the product.

Included operations are provisional. A reversible fork marks the old branch and its operations
`reverted`, then ingests the replacement branch. Irreversible checkpoints cannot be reverted.
Materialized business state advances only from accepted irreversible evidence. Stable source,
block, transaction/operation, and event identities make replay idempotent.

Source disagreement, excessive reorganization depth, malformed accepted payloads, or an attempted
irreversible fork fail closed and require operator reconciliation.

## 9. Resource credits

Player-authorized posting activity normally consumes the player's RC. Provisioning and optional
support may use narrowly scoped delegation from configured accounts. Delegation and reclaim are
separate, journaled workflows with recipient, maximum RC, purpose, eligibility, cooldown, and
irreversible operation evidence.

Each official service account is monitored independently. Capacity alerts use measured serialized
transactions and current RC data; source code does not assume a fixed transaction fee.

## 10. Security and privacy

- Production secrets live in the deployment secret store and are injected only into the workload
  that needs them.
- Logs contain safe IDs, state transitions, and reason codes—not tokens, authorization codes,
  private keys, signer responses, or raw custody-provider payloads.
- All external endpoints use TLS; production PostgreSQL requires verified encrypted transport.
- Player and service allow-lists are exact lowercase Hive account names and versioned policies.
- Player actions that create posts, votes, transfers, purchases, entries, or claims are explicit
  and auditable.
- Stored chain data is limited to public evidence required for product function and reconciliation.

## 11. Availability behavior

If Hive, HAfAH, an RPC provider, sponsor, custody provider, or signer is unavailable:

- active lobbies and matches continue through Nakama and PostgreSQL;
- local terminal results continue to commit normally;
- new Hive authentication/provisioning and Hive-dependent actions pause or retry safely;
- pending official operations remain durably journaled and fenced;
- cached chain-derived state remains at the last irreversible checkpoint and is not guessed.

## 12. Verification and deployment

Required automated coverage includes canonical serialization, role/account policy denial,
idempotency conflicts/replay, signer mismatch, fork rollback, LIB promotion, collectible
issue/revoke materialization, payment matching, provisioning retries, claim recovery, and database
least privilege.

Production deployment on Hetzner requires separately provisioned PostgreSQL, API, Nakama, workers,
TLS endpoints, Hive/HAfAH providers, service accounts, public keys, signer endpoints, sponsor/custody
contracts, backup/restore procedures, monitoring, and alert thresholds. Repository examples contain
no live credentials.

Deployment-specific account names, provider endpoints, token allow-lists, economic limits, sponsor
contracts, and RC thresholds remain configuration or explicitly tracked decisions.
