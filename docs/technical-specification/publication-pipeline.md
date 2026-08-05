# Hive event pipeline

This note records the implemented boundaries for authoritative terminal results and application
events written to Hive. The protocol contract remains
[`Hive-Layer-Design.md`](./Hive-Layer-Design.md).

## Terminal results

The Nakama runtime owns `commitTerminalResult`. It canonicalizes one complete terminal-result JSON
document, computes SHA-256 over those exact UTF-8 bytes, validates participant/discovery/like
identities, and opens a serializable transaction that locks the round. The transaction inserts the
detailed evidence and immutable initial revision before moving the round from `answer_check` to
`completed`. PostgreSQL's deferred terminal-bundle constraint validates the aggregate at commit.

`game.round_result_revision.canonical_complete_result` retains the exact canonical bytes and a
database constraint verifies their SHA-256. A repeated round ID is an idempotent replay only when
the bytes, hash, schema, scoring rules, and detailed evidence match. Conflicting retries fail
closed. Later corrections append a linear revision; existing revisions are immutable.

## Collectible issuer

`workers/collectible-issuer` accepts trusted internal commands for `collectible_issued` and
`collectible_revoked`. A commerce or achievement job must authorize and freeze the command first;
there is no public endpoint. The worker validates canonical metadata through the typed Hive Gateway
protocol, journals the signing attempt, and uses only the isolated `collectible_issuer` posting
policy. Unrelated service credentials cannot issue or revoke assets.

WAX constructs the unsigned transaction. The worker journals its exact operation hash and
transaction ID before sending the complete request over HTTPS to an isolated signer; it holds no
private key. The signer independently reconstructs the operation, enforces the configured
role/account/public-key/key-reference tuple, and durably fences each signing attempt.

## HAF and finality

The HAF projector stores raw application operation evidence immediately. Before LIB, a fork marks
that evidence reverted and does not mutate business state. Only an irreversible, accepted,
allow-listed collectible event may advance the collectible projection and ownership cache.

Issuance must match a local collectible definition, owner, metadata hash, and optional payment
reference. Revocation must reference its finalized issuance. Reprocessing is idempotent by stable
event and operation identity.

## Deployment gates

Production requires provisioned Hive service accounts, posting public keys, isolated signer
endpoints/credentials, Hive RPC/chain identity, TLS database URLs, and Hetzner workload secrets.
Those values are configuration, not repository defaults. Migrations run as a release step; workers
verify their dedicated NOLOGIN role on every checked-out connection and never migrate at startup.
