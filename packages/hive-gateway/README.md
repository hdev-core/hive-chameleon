# Hive Gateway foundation

This workspace owns Hive Chameleon's typed Hive protocol and transaction boundary. It constructs
only allow-listed operations, uses WAX for transaction serialization and signature recovery, and
requires isolated signers to revalidate the complete unsigned transaction before a provider sees
its digest. The signer boundary also resolves the requested role and policy version through a
trusted registry and requires the account, authority, public key, and opaque key reference to match
that registry exactly. Before calling the provider, it atomically reserves the idempotency key in
an injected durable ledger bound to the canonical operation, WAX digest, transaction, policy, and
key reference. Identical completed retries replay the validated signature; conflicting reuse is
rejected. Once a provider invocation may have begun, its durable reservation is non-expiring. A
provider or ledger-completion failure leaves that reservation unresolved for operator
reconciliation; it is never aborted automatically, so a retry cannot create a second signature.

The package contains no Hive private-key implementation or provider-specific custody adapter.
`DigestSignatureProvider` is a port implemented inside a separately protected signing boundary.
Provider implementations must return the final 65-byte Graphene compact signature and meet the
managed-signing recipe in `docs/technical-specification/integrations/`.

Testing helpers are available only through `@hive-chameleon/hive-gateway/testing`, contain public
fixtures rather than a private key, and throw when loaded with `NODE_ENV=production`.

```bash
npm run typecheck --workspace @hive-chameleon/hive-gateway
npm run test --workspace @hive-chameleon/hive-gateway
```
