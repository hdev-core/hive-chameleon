# Product API

The NestJS API now owns direct-Hive and Google game-session establishment, refresh rotation,
logout, restricted Google onboarding, and the scoped Nakama handoff.

## Local configuration

Start the application PostgreSQL stack and apply migrations, then copy `.env.example` to a local
ignored `.env` or export the values through your shell. Production refuses to start without
independent 32-byte `AUTH_TOKEN_SECRET` and `AUTH_IDENTITY_LOOKUP_KEY` values. The first signs
short-lived access/onboarding JWTs and HMACs refresh-token lookups; the second makes the verified
Google issuer/subject lookup deterministic without storing the raw subject or email.

Direct Hive login signs the exact UTF-8 challenge returned by
`POST /api/v1/auth/hive/challenges`. Keychain/HiveAuth integrations submit the resulting canonical
65-byte compact secp256k1 signature as 130 lowercase hexadecimal characters. The backend consumes
the challenge once, recovers the signing key from SHA-256 of the exact challenge bytes, and checks
the account's current posting authority through Hive RPC before creating a player session.

Google uses authorization-code + PKCE exchange through Google's maintained Node library. Redirect
URIs must match the configured allowlist exactly. Only the verified issuer and stable subject are
used for identity; email is never an ownership key. A new subject receives an onboarding token,
not a playable player or ordinary access token.

## Provisioning gate

The account-provisioning coordinator uses four provider-neutral contracts:

- a custody provider generates non-exportable owner, active, posting, and memo keys and returns
  only public keys plus opaque references;
- an approved signup sponsor consumes an account-creation token via
  `claim_account`/`create_claimed_account` and delegates initial Resource Credits;
- the Hive projection verifies the exact account, authorities, RC evidence, and irreversibility;
- the PostgreSQL repository makes every stage retryable under stable idempotency keys and links a
  playable identity only after all verification passes.

No production custody provider or signup sponsor is selected by this repository. The onboarding
API reports `503 provisioning_provider_unavailable` until approved adapters and policy metadata
are configured. This is deliberate fail-closed behavior; Hetzner is the hosting environment, not
a substitute for a custody/key-management provider.

The `CustodialPlayerSigner` accepts only an already-authorized, expiring grant containing an opaque
key reference. It verifies every returned signature against the expected public key and never
accepts a raw private key, arbitrary client-selected key reference, or an AWS-specific object.
