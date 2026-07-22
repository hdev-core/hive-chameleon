# Match publisher

This worker turns terminal-result publication requests into immutable `match_results_batch`
events. It locks eligible requests, orders results by completion time and round ID, and freezes the
event UUID, batch UUID, canonical JSON bytes, SHA-256, byte count, and ordered membership in one
serializable database transaction. It flushes at five minutes, 20 results, or 6 KiB. A result that
cannot fit alone is rejected and logged; fields are never truncated.

Broadcast attempts claim an existing outbox row with a lease. Every retry reparses and rehashes the
stored canonical payload and keeps its logical event/batch identity. A fresh Hive transaction may
use a distinct signing-attempt idempotency key, while HAF deduplicates the stable event ID. The
worker holds no private key: it sends the complete unsigned WAX transaction to an HTTPS isolated
signer which independently enforces the `match_publisher` role and posting policy. Each prepared
attempt is journaled in `hive_projection.transaction_intent` before signing.

The database login must be a member of only the `hc_match_publisher` NOLOGIN workload role. Every
checked-out connection activates and verifies that role. Apply migrations before startup; the
worker never migrates production state itself.

```bash
cp workers/match-publisher/.env.example workers/match-publisher/.env
npm run build --workspace @hive-chameleon/match-publisher
npm run start --workspace @hive-chameleon/match-publisher
```

Production requires TLS for PostgreSQL, Hive RPC, and the signer endpoint. The bearer token is a
transport credential only; the isolated signer must still reconstruct the operation, validate its
trusted role/policy/account/key reference, and durably fence each signing idempotency key.
