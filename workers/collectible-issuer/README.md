# Collectible issuer foundation

This package provides the role-isolated command boundary for `collectible_issued` and
`collectible_revoked` events. A trusted commerce/achievement job supplies a frozen UUIDv7 event ID,
timestamp, attempt number, and approved public metadata. The service validates and canonicalizes
the typed event through the Hive Gateway, journals the exact operation hash and transaction ID,
and broadcasts one posting-authority `hive.chameleon` `custom_json` through an isolated signer.

The package intentionally has no public HTTP endpoint and no private-key implementation. The
calling job remains responsible for proving that a purchase/reward/revocation is authorized and
for retaining its stable event data. Each uncertain retry increments the signing attempt while
keeping the same logical event ID and payload. The signer independently permits only the
`collectible_issuer` role/account/key-reference policy; unrelated service credentials are rejected.

`PostgresCollectibleIssuerJournal` records only this service's rows in
`hive_projection.transaction_intent` and establishes `SET ROLE hc_collectible_issuer` on every
connection. Provider-specific job ingress and production signer credentials remain deployment
work, not source-code defaults.
