# Public-event publication pipeline

This note records the implemented public-event foundation. The protocol contract remains
[`Hive-Layer-Design.md`](./Hive-Layer-Design.md); this document identifies the executable boundaries
and their retry/finality behavior.

## Terminal result

The Nakama runtime owns `commitTerminalResult`. The caller supplies one canonical complete-result
JSON document and its durable object-storage key. The boundary computes SHA-256 over those exact
bytes, validates the participant/discovery/like identities, starts a serializable transaction, and
locks the round. It inserts detailed rows, the immutable initial revision, and the initial
publication request before changing the round from `answer_check` to `completed`. PostgreSQL's
deferred terminal-bundle constraints validate the aggregate at commit. A repeated round ID is an
idempotent replay only when the hash, object key, result schema, scoring rules, and active initial
request match; conflicting retries fail closed.

## Match publisher

`workers/match-publisher` runs with only `hc_match_publisher` database privileges. One serializable
claim reads server-committed evidence, converts database outcomes to the public protocol, orders by
`completed_at` and `round_id`, and freezes all of the following together:

- event UUID and logical batch UUID;
- ordered request/revision/round membership;
- canonical application JSON bytes and parsed JSON;
- SHA-256 and UTF-8 byte count;
- publisher, event/schema versions, count, and half-open publication window.

The default flush policy is five minutes, 20 results, or 6 KiB. Required fields are never dropped;
an individually oversized result is an operational failure. Outbox retries reparse and rehash the
stored payload and never rebuild the logical event. Each new Hive transaction attempt receives a
separate signer idempotency key because its TAPOS/expiration header may change, while the payload,
event UUID, and batch UUID remain stable for HAF deduplication.

WAX constructs the unsigned transaction. The worker journals its exact operation hash and
transaction ID before sending the complete request over HTTPS to an isolated signer. It holds no
private key. The signer must independently reconstruct the operation, enforce the trusted
`match_publisher` posting policy/account/public-key/key-reference tuple, and durably fence the
signing attempt. Database leases and bounded backoff prevent ordinary concurrent retries.

## Collectible issuer

`workers/collectible-issuer` exposes trusted internal commands for `collectible_issued` and
`collectible_revoked`. A commerce or achievement job must first authorize and freeze the command;
there is deliberately no public endpoint in this foundation. The service validates canonical
metadata through the typed protocol, journals the signing attempt, and uses only the isolated
`collectible_issuer` posting policy. Match-publisher credentials cannot issue or revoke assets.

## HAF and finality

The HAF projector stores an accepted match envelope immediately as reversible typed evidence.
Before LIB, a fork marks that evidence reverted; it does not alter the business view. Only an
irreversible operation may create a `match_result`, append a correction/invalidation edge, create a
collectible event, or advance the collectible ownership cache. Match corrections extend the
accepted current pointer linearly. Collectible issuance must match a local definition, owner, and
optional payment reference before projection; revocation must reference its finalized issuance.

The match worker reconciles typed HAF evidence back to its operational outbox. Inclusion records
the observed operation, reversion makes the same logical payload eligible for replay, and
irreversibility marks every member request published. PostgreSQL remains authoritative for the
complete gameplay result; irreversible Hive history is authoritative for the public summary.

## Deployment gates

Production still requires provisioned Hive service accounts, posting public keys, isolated signer
endpoints/credentials, Hive RPC/chain identity, TLS database URLs, and Hetzner workload secrets.
Those values are configuration, not repository defaults. Migrations run as a release step; workers
verify their dedicated NOLOGIN role on every checked-out connection and never migrate at startup.
