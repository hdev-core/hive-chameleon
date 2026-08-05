# Hive Chameleon — Data Model and ERD Design

**Deliverable:** Design the data model / ER diagram (core entities and relationships)

**Database:** PostgreSQL

## 1. Purpose

This document defines the durable application data model for Hive Chameleon. It explains the ownership boundaries, assumptions, entity responsibilities, key relationships, integrity rules, indexing strategy, and PostgreSQL decisions represented by the accompanying DBML source.

The model covers the approved product surface without treating PostgreSQL as the real-time simulation database. It supports:

- direct-Hive authentication, Google OIDC identity mapping, idempotent real-account provisioning, and one-device sessions;
- custodial key-reference lifecycles, explicit player signing intents, optional self-custody claim, and delayed recovery-account transfer;
- friends, blocks, lobby invitations, and notifications without chat or direct messages;
- persistent lobby history and host migration;
- completed Casual and Infection round history, scores, discoveries, disguise likes, immutable result revisions, and achievements;
- official and community maps, immutable versions, review, distribution, and showcase posts;
- on-chain collectible ownership projected into the application;
- cosmetic offers, payments, purchases, and loadouts;
- tournament registration, matches, scoring, entry payments, and payouts; and
- fork-aware projections of the limited Hive data used by the product.

The DBML is the source ERD and a migration input, not the final production migration set. PostgreSQL features that DBML cannot represent are specified in Section 10.

## 2. Data ownership and system boundaries

Hive Chameleon deliberately separates durable domain data, real-time match state, blockchain truth, and binary assets.

| Boundary | Authoritative owner | Included here | Examples |
| --- | --- | --- | --- |
| Durable game and community data | Hive Chameleon PostgreSQL | Yes | Profiles, friends, lobbies, completed rounds, maps, achievements, tournaments |
| Real-time simulation | Authoritative Nakama match runtime | Private recovery checkpoint only | Accepted avatar snapshots, shots, timers, roles, score cadence, and command idempotency remain live in Nakama; a versioned private checkpoint permits fail-closed process recovery |
| Short-lived coordination | Redis/Nakama presence plus private PostgreSQL recovery checkpoint | Recovery deadline only | Online presence and active sockets remain ephemeral; current-round reconnect reservations/deadlines survive a Nakama restart |
| Hive account identity | Standard Hive account and its authorities | Normalized mapping, provisioning/claim state, public keys, opaque custody references, and sessions | Direct signed proof, Google-provisioned account, authority/recovery lifecycle |
| Google game authentication | Verified Google OIDC issuer and subject | Deterministic protected identity lookup and lifecycle only | Game session authentication; never a Hive signature or email-based ownership link |
| Collectible ownership | Accepted Hive event history from the official issuer | Yes, as a validated projection/cache | Issuance, revocation, finalized owner |
| Tournament money movement | Hive/Hive-Engine transactions | Yes, as payment projections | Entry transfer, payout transfer, finality |
| Map showcase publication | Hive posts and votes | Yes, as a cached projection | Author/permlink, current vote, publication state |
| Live and complete gameplay result | Authoritative game service/PostgreSQL | Yes | Matchmaking, reconnect, simulation outcome, complete detailed round result, revisions |
| Map files and media | Object storage | Metadata and hashes only | Map package, screenshots, thumbnails, cosmetic assets, disguise snapshots |
| HAF internal tables | HAF deployment | No | Raw chain ingestion and fork processing internals |

### 2.1 Hive boundary

The model follows the current Hive-layer decisions:

- Direct-Hive authentication uses a posting-authority challenge signed by an external Hive provider. Google OIDC instead establishes the game session and maps the verified issuer/subject to a newly provisioned real Hive account; Google authentication is not a Hive signature.
- A Google-provisioned account begins under platform custody. PostgreSQL stores four public keys, opaque custody-provider references, and non-secret lifecycle evidence, never private material. Supported posting and active operations still require an explicit authenticated, allow-listed player intent.
- PostgreSQL is authoritative for live play, complete detailed results, and append-only result revisions.
- Tournament eligibility, brackets, winner calculation, and aggregate state remain in PostgreSQL; entry and payout value movement uses native HIVE/HBD or Hive-Engine operations.
- Collectibles use official issuance/revocation events, while map showcases use native Hive posts and votes. PostgreSQL projections do not replace Hive as the source of truth for those accepted public events.
- Provisioning is coordinated through the external signup sponsor and is not a platform service-account role. Collectible issuance, treasury payments, and later general RC support remain separate official service-account roles; none reuse player custody keys or each other's signing credentials.
- During a Hive outage, active matches and other non-Hive gameplay continue. New Hive authentication/provisioning and Hive-dependent player actions pause or retry safely. No active match is aborted solely because Hive is unavailable.

## 3. Modeling principles

1. **Relational core first.** Stable domain concepts use normalized tables, foreign keys, uniqueness constraints, and explicit lifecycle enums.
2. **JSONB only for versioned or extensible data.** Examples are control mappings, score breakdowns, map manifests, technical validation reports, tournament rules, and raw Hive payloads. IDs, ownership, money, states, and timestamps remain typed columns.
3. **Immutable facts over rewritten history.** Completed round results, result revisions, submitted map content and assets, reviews, indexed Hive operations, and payment evidence are append-only or tightly protected. Corrections, invalidations, revocations, and fork state use later records or explicit lifecycle transitions.
4. **Derived data is rebuildable.** Player statistics, tournament aggregate scores, map play counts, and Hive display totals are caches backed by durable facts.
5. **No secrets in domain records.** Passwords and invitation tokens are hashed. Game refresh tokens are stored only as hashes. Hive private keys, master passwords, seed phrases, recovery material, custodial-key plaintext, service signing keys, raw Google access/refresh/ID tokens, lobby passwords, and invitation codes are never stored.
6. **Server authority is explicit.** Clients request actions but cannot declare discoveries, results, ownership, approvals, or payment completion.
7. **Future phases do not weaken current rules.** Creator and tournament structures can expand, but collectible transfer/resale is intentionally absent because approved collectibles are non-transferable.

## 4. Schema organization

The ERD contains 68 application tables grouped into the existing seven PostgreSQL schemas.

| Schema | Tables | Responsibility | Primary roots |
| --- | ---: | --- | --- |
| `identity` | 14 | Direct/Google identity, account provisioning, custody/claim state, profiles, sessions, settings, staff-role grants, and authorization evidence | `external_identity`, `hive_account_provisioning`, `player` |
| `social` | 5 | Friend requests, friendships, blocks, invitations, notifications | `friend_request`, `friendship` |
| `game` | 15 | Lobby lifecycle, exact completed results/revisions, statistics, achievements | `lobby`, `game_round`, `round_result_revision` |
| `content` | 9 | Maps, versions, assets, review, distribution, showcase workflow | `map`, `map_version` |
| `commerce` | 8 | Collectible catalog and instances, loadout, offers, purchases, payments | `collectible_definition`, `payment_transaction` |
| `tournament` | 8 | Tournament rules, entries, matches, aggregate scores, payouts | `tournament` |
| `hive_projection` | 9 | Validated, fork-aware application projections of required Hive operations | `block_checkpoint`, `operation`, `collectible_event` |

`hive_projection` is a logical security and ownership boundary. HAF should run in its own managed database or equivalent isolated schema/role boundary. A dedicated indexer reads from HAF or a public HAF/HAfAH service and writes only the application projections defined here.

## 5. Entity catalog and relationships

### 5.1 Identity

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `identity.external_identity` | Stable verified Google OIDC identity before and after provisioning | Unique provider/issuer/keyed-subject hash; optional player link; stores neither email nor raw subject/tokens |
| `identity.hive_account_provisioning` | One durable, idempotent sponsor-backed real-Hive-account creation job | Unique external identity and idempotency key; requested permanent username, sponsor policy/request reference, creation/RC operation references, retries, verification, optional resulting player; no raw signup code |
| `identity.custody_key_reference` | Non-secret lifecycle row for one custodial owner, active, posting, or memo key | Belongs to provisioning and later player; stores public key and opaque provider reference only; destruction evidence is non-secret |
| `identity.hive_account_claim` | Authority rotation, custody destruction, and delayed recovery-account transition | One pending claim per player; references one owner-authorized intent, both included operations, the later virtual operation, and distinct completion milestones |
| `identity.player` | Canonical playable in-game identity keyed by a normalized Hive username | Created for Google only after provisioning is verified; records current custodial/self-custodial control state |
| `identity.player_profile` | Cached public Hive profile fields and game-facing profile timestamps | One-to-one with player; Hive profile metadata is cached, not identity authority |
| `identity.auth_session` | Playable game refresh session with separate authentication and Hive-signing fields | Direct challenge or Google OIDC authentication; external or custodial signing provider; no Google token; many historical sessions, one unrevoked session |
| `identity.player_preference` | Cross-platform comfort, accessibility, audio, UI, and Streamer Mode settings | One-to-one with player |
| `identity.player_platform_setting` | Platform-specific sensitivity and control mappings | One row per player/platform |
| `identity.player_appearance` | Persistent lobby character form, size preset, pose, and paint artifact reference | One-to-one with player; cube uses only the approved `x1_0` size |
| `identity.platform_role_approval` | Independent approval evidence for high-risk staff-role grants or extensions | Requester and approver must differ; approved scope, role, subject, and validity must exactly match the assignment |
| `identity.platform_role_assignment` | Time-bounded staff/operator authorization | Global or typed resource scope, immutable grant evidence, non-overlapping active validity, and append-only grant/revocation audit references |
| `identity.authorization_audit_event` | Non-secret authorization decision evidence | Append-only human/service allow, deny, grant, and revoke records with correlation and reason; retained at least 180 days in production |

The pending-Google boundary is explicit: `external_identity` and `hive_account_provisioning` exist before a player. `identity.player` and a playable `auth_session` are created only after the named Hive account is irreversible, its observed authorities match the four expected public keys, and initial RC support is verified. No guest or partly provisioned player row is created. A returning verified issuer/subject resumes the same external identity and logical job. The canonical Hive username is lowercase, unique, and immutable once the account is observed on Hive.

The Google lifecycle represented by these rows is:

```text
Google verified
→ username confirmed
→ custody public keys ready
→ sponsor request accepted
→ sponsored Hive account created
→ sponsor-backed initial RC verified
→ player ready
→ optional authority claim
→ custodial signing disabled and keys destroyed
→ recovery change pending
→ full self-custody
```

Provisioning retries the same sponsor request through uncertain or partial outcomes. A sponsor
timeout triggers an on-chain creator/recovery, name, and expected-authority comparison; an
independently created or mismatched account is never linked. Failure after account creation
resumes at sponsor RC verification/support without submitting a second signup. Reversible
creation/RC evidence, database failure after sponsor success, Hive outage, custody-provider
outage, and unavailable sponsor/signup capacity remain recoverable states. If a username is
taken before matching creation succeeds, the same job returns to username confirmation.

Claim transfers the same account and never exports the old custodial private keys. The claim row distinguishes irreversible authority rotation, disabled custodial signing, destruction of all four old keys, the still-effective sponsor/creator recovery account, and final recovery-account effectiveness. `self_custody_complete` is impossible until the selected non-platform recovery account becomes effective after Hive's approximately 30-day delay and HAF observes current account state plus `changed_recovery_account`.

Authentication and signing remain independent. Google OIDC authenticates a game session but does not authorize a Hive transaction. Before claim, an eligible Google session can create an explicit allow-listed custodial posting/active intent. Direct-Hive and claimed players use an external Hive signer. The exact post-claim Google-session behavior remains open.

### 5.2 Social

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `social.friend_request` | Directed request workflow | Requester and recipient must differ; only one pending request exists for an unordered pair |
| `social.friendship` | Accepted, undirected relationship | Pair is stored canonically as `player_low_id < player_high_id` |
| `social.player_block` | Directed block relationship | Composite primary key; blocker and blocked player must differ |
| `social.lobby_invitation` | Expiring lobby invitation | Links lobby, inviter, and invitee; invitation authorization can bypass private-lobby password entry |
| `social.notification` | In-game notification inbox | Typed payload with optional related entity; read and expiry timestamps |

Friends, invitations, blocking, presence, and lobby activity remain off-chain. No conversation, chat-message, or direct-message entities are included.

### 5.3 Lobby and round history

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `game.lobby` | One persistent rolling lobby lifecycle | Current host pointer, region, visibility, capacity, hashed password, system lifecycle close timestamp |
| `game.lobby_access_token` | Hashed, expiring invitation link/code credential | Belongs to a lobby and creator; raw code is never persisted |
| `game.lobby_membership` | Player join/leave history and durable pre-round Hunter nomination | Many memberships per lobby; at most one open membership per player globally; nomination is consumed at round start |
| `game.lobby_host_assignment` | Append-only host ownership history | Exactly one open assignment per lobby; records creation, transfer, leave, disconnect, or AFK reason |
| `game.lobby_configuration` | Current host-configurable rules between rounds | One-to-one with lobby; the chosen settings are snapshotted into each round |
| `game.game_round` | Durable round header and immutable initial rule/result snapshot | Unique sequence within lobby; exact map version, server build, match protocol, `result_schema_version`, `scoring_rule_version`, and canonical complete-result SHA-256 |
| `game.round_participant` | One participant result for a completed round | Unique player per round; initial/final role supports Infection conversion |
| `game.round_discovery` | Hunter discovery of a Hider | Both players must be participants in the same round; one discovery per Hider |
| `game.round_disguise_snapshot` | Object-storage reference for an Answer Check disguise | At most one snapshot per participant |
| `game.round_like` | One Answer Check choice per voter | Target must be a participant in the same round; no self-like |
| `game.round_result_revision` | Append-only initial/correction/invalidation chain | Initial and correction rows retain exact canonical UTF-8 JSON bytes with database-verified SHA-256; unique previous edge and sequential same-round trigger prevent branching |
| `game.player_mode_stat` | Rebuildable Casual/Infection summary cache | One row per player/mode; round history remains authoritative |
| `game.achievement_definition` | Versioned off-chain achievement criteria | May reference a collectible badge definition |
| `game.player_achievement` | Player progress and earned state | One row per player/definition; earned collectible instance linked after finalized issuance |

`lobby.closed_at` is controlled by the lobby service for an empty, expired, or administratively terminated lifecycle; it is not a host-facing **Close lobby** capability. A departing host triggers ownership transfer while eligible players remain.

#### Round persistence rule

The authoritative match runtime owns the live round. PostgreSQL persists the round header when the server starts the round. Nonterminal `game_round.status` values are best-effort operational mirrors for history and support; they are never authoritative for simulation, phase timing, or reconnect restoration. Terminal commit comes from the authoritative match server. For a completed round, one transaction commits the terminal header, participants, discoveries, disguise snapshots, likes, and the initial exact canonical `round_result_revision`; only then are rebuildable caches updated. Participant rows are terminal result records rather than live presence rows. An aborted round stores only the minimal header, end time, and abort reason.

Completed detailed rows are immutable. A correction appends an immutable canonical result snapshot/revision; an invalidation appends an invalidation revision. Neither path changes or deletes the original round, participants, discoveries, likes, or initial revision. The unique `previous_revision_id` edge, one revision number per round, and same-round/sequential trigger produce one linear chain whose leaf is the current local interpretation.

### 5.4 Maps and creator workflow

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `content.map` | Stable map identity, creator attribution, discovery metadata | Official or community origin; community map requires a creator |
| `content.map_version` | Versioned submission content and controlled review lifecycle | Unique version number per map; submitted manifest/package/assets remain immutable while status timestamps advance through commands |
| `content.map_lifecycle_event` | Append-only publication, suspension, removal, and restoration history | Records old/new lifecycle, optional version, actor, and creator-facing reason |
| `content.map_asset` | Package, thumbnail, screenshot, or showcase-media pointer | Object key, media type, byte size, and SHA-256 hash; one package per version |
| `content.map_review` | Append-only manual review decision/history | Links reviewed version and reviewer; includes creator-facing and internal notes |
| `content.tag` / `content.map_tag` | Controlled discovery tags | Normalized many-to-many relationship |
| `content.map_distribution` | Per-platform availability | Separates dynamic desktop delivery from web-shipped availability and declares the required game build plus realtime protocol compatibility |
| `content.map_showcase` | Draft-to-Hive publication workflow | Off-chain draft links to a projected Hive post after publication |

Map authorship, map versions, review, and file hashes remain authoritative in PostgreSQL and object storage. Hive is used only when the creator explicitly publishes the optional showcase post or votes on one. After submission, a version's identity, manifest, package, and asset content are immutable; controlled review/status fields may advance. When an updated version is submitted, the previous approved distribution remains playable until the replacement passes review and is activated atomically. A removed or suspended map cannot be selected for new lobbies, while its historical round references remain intact and the creator-facing lifecycle reason remains available.

Before creating a map-showcase vote signing request, the service verifies that the voter participated in a completed round whose current result-revision chain is not invalidated. Hive votes are the only map-rating mechanism; there is no separate player-rating table.

### 5.5 Collectibles, shop, and payments

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `commerce.collectible_definition` | Catalog definition shared by many owned copies | Defines badge, weapon skin, material, emote, frame, or victory effect |
| `commerce.collectible_asset` | Platform-specific asset pointer and content hash | Many assets per definition |
| `commerce.collectible_instance` | One distinct on-chain-issued copy owned by one Hive player | Hive issuance UUID is the primary key; event history is authoritative; owner is immutable |
| `commerce.player_loadout` | Off-chain equip history | One active collectible per compatible slot and one active use of an instance |
| `commerce.shop_offer` | Time- and quantity-bounded catalog offer | References one collectible definition |
| `commerce.shop_offer_price` | Price option for a supported rail/asset | Allows HIVE, HBD, AFIT, and later external payment rails |
| `commerce.payment_transaction` | Unified incoming/outgoing payment workflow and evidence | Links transaction intent and external operation; records inclusion and irreversibility |
| `commerce.purchase` | Purchase orchestration | A fulfilled purchase must have a verified payment and issued collectible instance |

All purchased copies receive distinct collectible-instance UUIDs. Badges and cosmetic instances are non-transferable, so no ownership-transfer entity or event exists. Equip state is off-chain and does not change ownership.

### 5.6 Tournaments

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `tournament.tournament` | Tournament definition, schedule, fee, rules, and lifecycle | Supports the approved candidate formats without committing the product to all of them initially |
| `tournament.tournament_entry` | One player registration and payment link | Unique player per tournament; no rejoin workflow is modeled |
| `tournament.prize_rule` | Placement split or fixed payout rule | Multiple placements/assets per tournament |
| `tournament.tournament_match` | Scheduled match or bracket node | Winner references an entry; detailed tournament/bracket state remains in PostgreSQL |
| `tournament.match_entry` | Match-to-entry participation and result | Many-to-many bridge with score/outcome |
| `tournament.match_game_round` | Exact game rounds counted toward a tournament match | Each game round belongs to at most one tournament match |
| `tournament.entry_score` | Rebuildable aggregate standing | One-to-one with tournament entry |
| `tournament.payout` | Expected and observed treasury payout | Links placement, amount, recipient entry, and outgoing payment transaction |

There is no separate custom tournament-settlement, bracket, or payout-calculation event. Tournament progression and detailed outcomes remain in PostgreSQL, while entry and payout transfers remain publicly verifiable through their native transaction evidence. The initial implementation accepts only the configured official treasury; a community-organized treasury model remains deferred and undecided. The general game server cannot sign treasury payouts. Cancelled, unfilled, forfeited, or disconnected entries are not automatically refunded, and the unique player/tournament relationship deliberately prevents rejoining the same tournament.

### 5.7 Hive projections and signing workflow

| Entity | Responsibility | Important relationships and rules |
| --- | --- | --- |
| `hive_projection.block_checkpoint` | Per-source block/fork evidence, including blocks with no relevant operation | Retains old and replacement branches, parent identity, reversible/irreversible state, and one current block per source/height |
| `hive_projection.operation` | Fork-aware raw envelope for a relevant Hive operation | Stable HAF/HAfAH identity, checkpoint, payload, validation/rejection evidence, and included/irreversible/reverted state; malformed or unauthorized events remain auditable without typed rows |
| `hive_projection.collectible_event` | Validated `collectible_issued` or `collectible_revoked` payload | Only allow-listed official issuer events can update domain ownership |
| `hive_projection.asset_transfer` | HIVE/HBD or Hive-Engine transfer projection | Correlates tournament/shop payment; AFIT also requires successful Hive-Engine execution |
| `hive_projection.community_post` | Current map showcase post projection | Unique author/permlink with created and latest operation references |
| `hive_projection.community_vote` | Current voter state for a showcase post | Unique voter per post; later votes replace the projected current state |
| `hive_projection.transaction_intent` | Server-generated operation intent and idempotency record | Separates external-wallet, custodial-player, and official-service authorization; references eligible session/key or isolated service role; never stores keys |
| `hive_projection.rc_delegation` | Sponsor-supplied initial RC or later platform RC-support lifecycle | Expected posting-authority `custom_json` ID `rc`/`delegate_rc` evidence, max-RC amount, delegator kind, optional platform service role, grant/reclaim/finality and eligibility evidence |
| `hive_projection.sync_cursor` | Per-source indexer progress and health | Tracks processed and irreversible blocks |

For native Hive operations, irreversibility is based on HAF/LIB state. Pending operation evidence may be reverted and replayed after a fork. Materialized ownership and payment state advances only from accepted irreversible evidence.

Hive-Engine token actions are carried through Hive operations but require a second validation of the contract execution result before AFIT payment is accepted. If indexing is unavailable, cached finalized ownership may remain readable, but ownership-changing actions, payments, and finality-dependent transitions pause.

### 5.8 Signing, custody, and secret boundary

`identity.auth_session.authentication_method` answers how the game session was established. `hive_signing_provider` answers how a later player operation may be signed. `hive_projection.transaction_intent.authorization_mode` distinguishes external player signing, an explicitly authorized custodial player operation, and an official service operation. A Google OIDC session therefore never masquerades as Hive authorization.

The database holds only Hive public keys, deterministic public authority text, opaque custody-provider key references, key lifecycle/destruction timestamps, and non-secret evidence references. It must never hold:

- owner, active, posting, or memo private keys;
- Hive master passwords, seeds, recovery material, or exported credential files;
- custodial key plaintext or a provider credential capable of retrieving it;
- raw Google ID/access/refresh tokens or the raw OIDC subject used for lookup; or
- sponsor, issuer, treasury, or RC-support private keys or raw signup codes.

No production KMS, HSM, or custody product is selected by this model. Standard HashiCorp Vault Transit is not a drop-in candidate because its documented ECDSA key types omit secp256k1; a custom Vault plugin or HSM integration would be a distinct provider design. Every candidate remains gated by a feasibility/cost spike for secp256k1, Hive-compatible compact signatures, per-key authorization, non-exportability, destruction evidence, scaling, and optional future memo shared-secret support. The memo key is tracked for account creation and rotation; encrypted memo processing is not promised by this schema.

The external signup sponsor is not a platform service role and its Hive keys never enter the
system. Platform official roles remain distinct: the issuer signs collectible events; the treasury
signs payouts; and the RC-support role handles later assistance/reclaim. `transaction_intent.official_service_role` records those
authorization classes without storing a service key. Official service-account owner authorities
remain offline and outside the application model. Production account names remain configuration,
not schema values.

## 6. Primary cardinalities

The detailed relationships are declared as named `Ref` definitions in the DBML. The central cardinalities are:

- One verified Google provider/issuer/subject hash to one `external_identity`, one durable provisioning job, and at most one resulting player. The Google path has no player before the job is ready.
- One provisioning job to four current custodial key roles before claim; lifecycle history remains after destruction. One player may have only one pending claim.
- One `identity.player` to at most one profile, preference row, and current appearance at the database level; the account bootstrap transaction creates the required rows.
- One player to many historical sessions, platform settings, lobby memberships, round participations, purchases, tournament entries, and notifications.
- One lobby to at most one current configuration at the database level, plus many memberships, host assignments, and sequential rounds; lobby creation inserts the required configuration transactionally.
- One round to many participants, discoveries, likes, and a single linear append-only result-revision chain; at most one disguise snapshot per participant.
- One map to many immutable versions; one version to many assets, reviews, and platform distributions.
- One collectible definition to many collectible instances; each instance has exactly one owner and issuance event, with an optional later revocation event.
- One tournament to many entries, prize rules, matches, and payouts.
- One relevant Hive operation to at most one typed projection row of a given kind.

Foreign-key delete behavior is intentionally conservative. Historical and financial entities use `RESTRICT`; only pure join/configuration children such as map tags and offer prices use `CASCADE` where deletion cannot erase evidence.

## 7. State and transaction boundaries

### 7.1 Authentication and Google provisioning

For a direct-Hive session, the client obtains a nonce-bound challenge and Keychain, HiveAuth, HiveSigner, or another approved external provider signs with the player's posting authority outside Unity. The backend verifies account, authority, nonce, origin, expiry, and signature, then transactionally upserts the normalized player/profile, revokes the old session, and inserts the new hashed game refresh session. The short-lived challenge belongs in Redis rather than these durable tables.

For Google onboarding:

1. The backend validates the OIDC signature, configured issuer/audience, expiration, nonce/callback correlation, and subject. It derives `subject_lookup_hash` with a keyed HMAC whose key is outside PostgreSQL.
2. It upserts the unique `external_identity` and creates or resumes its single logical provisioning job after permanent username confirmation.
3. The custody boundary creates separate owner, active, posting, and memo keys. The job stores only their public keys and opaque references and advances to `keys_ready` only after all four rows exist.
4. The provisioning worker submits one idempotent request to the configured signup sponsor using
   a versioned policy and the permanent username plus four expected custody public authorities.
   It stores only an opaque non-secret sponsor request reference; raw signup codes/API credentials
   remain outside PostgreSQL.
5. The worker accepts creation and initial RC only after Hive shows the configured sponsor/creator,
   exact account and recovery account, exact authorities, and sufficient irreversible RC support.
   If the sponsor uses `create_claimed_account` and `delegate_rc`, those operations are projected
   as external sponsor evidence. `rc_delegation.delegated_max_rc` remains RC capacity, not HIVE,
   HP, or content-vote weight granted to the player.
6. The job reaches `ready` only after irreversible account creation, observed authority equality, and verified initial RC. One transaction creates/links the player and issues a playable session.

Concurrent callbacks and workers serialize on the same external identity/job. An uncertain broadcast is reconciled against Hive before retry. A matching already-created account resumes the same job; a mismatched account is rejected. A database failure after an on-chain success, RC failure after creation, fork rollback, or dependency outage changes retry state without creating a second job, Hive account, or player.

Provisioning/username/OIDC attempts are rate-limited by the auth and provisioning services. Exact thresholds and short-lived device/network risk signals belong in security configuration or purpose-built telemetry, not in identity ownership rows.

### 7.2 Custodial signing and self-custody claim

A Google-authenticated unclaimed player may explicitly authorize allow-listed posting operations or active-authority payments. The backend records an authenticated `transaction_intent`, validates the current session/account/key role and operation policy, and asks the custody boundary to sign only that canonical operation. The general backend and Unity never receive the private key. Direct-Hive and claimed players use an external signer instead. Official jobs use `authorization_mode = official_service` and a distinct service role, never a player session or custody key.

Claim is one idempotent workflow for the existing Hive account:

1. Store safe canonical representations of the player's new public owner/active/posting authorities, new memo public key, and selected valid non-platform recovery account.
2. Build one current-owner-authorized transaction containing `change_recovery_account` followed by `account_update2`; reference the one intent and both projected operations from the claim row.
3. Keep `authority_rotation_pending` until the transaction is irreversible, all new authorities match a fresh Hive read, and the pending recovery request names the selected account. A fork or uncertain response never triggers destruction.
4. Disable custodial signing and request destruction of all four old key references. Record separate signing-disabled, destruction-requested/completed, and non-secret evidence timestamps. Partial destruction remains `custody_destruction_pending` and cannot be mislabeled complete.
5. Enter `recovery_change_pending`. The sponsor/creator account remains the effective recovery
   account during Hive's approximately 30-day delay. The platform can no longer sign normal
   operations and does not control the sponsor's recovery authority, but the third-party role
   remains visible until Hive applies the change.
6. Mark `self_custody_complete` only after HAF observes the selected recovery account in current account state and the corresponding `changed_recovery_account` virtual operation.

The claim never exports the old platform keys or creates a replacement account. Authority rotation, custody destruction, recovery effectiveness, and full completion remain independently auditable.

### 7.3 Completed round results

A terminal result commit uses an idempotent round ID and one database transaction. It validates the result schema/scoring versions, canonical complete-result bytes and SHA-256, participant set, role rules, discoveries, and likes, then inserts the immutable detailed rows and initial result revision. Statistics and standings update only after this succeeds and remain rebuildable.

The exact canonical UTF-8 JSON bytes are retained on the revision and hash-checked by PostgreSQL. A correction appends a new local revision with a complete replacement snapshot. An invalidation appends a revision without replacement bytes. Unique revision numbers and previous-revision edges prevent branching. Aborted rounds never receive terminal result rows.

### 7.4 Host migration

Host migration is one serializable transaction that locks the lobby, closes the current `lobby_host_assignment`, inserts the replacement assignment, and updates `lobby.current_host_player_id`. The candidate-selection algorithm and lobby AFK heartbeat run in the authoritative lobby service.

### 7.5 Collectible issuance

1. An approved purchase, reward, or earned badge authorizes an isolated issuer service.
2. The issuer broadcasts the approved `hive.chameleon` collectible event through WAX.
3. The indexer observes the operation, validates namespace/schema/issuer/hash, and records the projection.
4. The collectible instance is pending at block inclusion and finalized only when irreversible.
5. Equip and fulfillment workflows consume finalized ownership only.

`hive.chameleon` remains a proposed protocol ID until manager approval before the first production broadcast.

### 7.6 Tournament payment

An unclaimed custodial player explicitly confirms an active-authority entry transfer in product; a direct-Hive or claimed player explicitly signs it through the selected external provider. The payment is correlated by tournament reference, sender, recipient, asset, and amount; a memo alone is not trusted. Registration becomes accepted only after the expected operation is irreversible and, for AFIT, after successful Hive-Engine execution. Payouts follow the same evidence path in the outgoing direction through the isolated treasury signer.

## 8. PostgreSQL conventions

| Concern | Decision |
| --- | --- |
| Primary IDs | Application-generated UUIDv7 stored as PostgreSQL `uuid` |
| Naming | Singular `snake_case` tables and columns; schema-qualified names |
| Time | `timestamptz`; services and database operate in UTC |
| Money/token quantities | `numeric(20,8)`; never floating point |
| Resource Credits | Integer-like `numeric(30,0)` max-RC capacity; never modeled as HIVE/HP |
| Scores | Fixed precision `numeric`; exact point rules are versioned |
| Hive usernames | Normalized lowercase, unique where identity is canonical |
| Google subject lookup | Keyed deterministic HMAC-SHA-256 over configured issuer/subject; HMAC key and raw subject remain outside the database |
| Asset codes | Normalized uppercase |
| Content integrity | SHA-256 lowercase hexadecimal hashes |
| Lifecycle values | PostgreSQL enums for stable, closed state sets |
| Extension data | JSONB only where fields are versioned, sparse, or provider-specific |
| Canonical outbound payload | Exact canonical `text` plus SHA-256; optional parsed `jsonb` is not the signing/retry byte source |
| Concurrency | `row_version` optimistic locking on frequently edited aggregates |
| External assets | Object-storage key + media type + size + content hash |
| Secrets | Only one-way hashes, public keys/authorities, and opaque non-secret references; all private signing, recovery, OIDC token, and service-key material is excluded |

UUIDv7 generation belongs in the application/shared service library so deployments do not depend on a particular PostgreSQL major version's UUIDv7 function.
The initial migrations enable `pgcrypto` to verify stored canonical-payload digests and
`btree_gist` to exclude overlapping active role-validity ranges. They do not enable
`uuid-ossp`; the database validates UUIDv7 version/variant bits without generating IDs.

## 9. Constraints and indexes represented in DBML

The DBML declares:

- primary, unique, and foreign keys;
- one-to-one, one-to-many, and composite relationships;
- enum-backed lifecycle states;
- time-order, range, non-self, canonical-pair, and terminal-state checks;
- query indexes for OIDC lookup, provisioning/claim retry, player history, lobby discovery, result-revision history, map browsing, payment reconciliation, tournament standing, and Hive block replay; and
- conservative delete/update actions on every relationship.

Every declared foreign key has a child-side index whose leading columns cover the relationship, including composite account, round, tournament, and projection references.

Important queries supported directly include:

- exact Hive username and deterministic provider/issuer/subject lookup;
- pending provisioning by state/retry/username, custody keys by account/role/state, and pending recovery transition;
- public lobby discovery by region and open status;
- a player's round/mode history and profile statistics;
- approved map/version and platform-distribution lookup;
- finalized collectible inventory and active loadout;
- pending payment/purchase/tournament workflows;
- local correction-chain traversal; and
- block-ordered, replay/fork-ordered, issuer-ordered, account-ordered, and application-namespace Hive projection reads.

JSONB columns intentionally have no default B-tree indexes. Add a GIN or expression index only after a real query requires a stable JSON path.

## 10. PostgreSQL migration rules not expressible in DBML

DBML cannot fully represent partial/expression indexes, triggers, deferrable constraints, row-level locking rules, or cross-table state validation. The migration set must add and test the following.

### 10.1 Required partial and expression indexes

```sql
CREATE UNIQUE INDEX uq_provisioning_reserved_username
    ON identity.hive_account_provisioning (requested_hive_username)
    WHERE state <> 'terminal_failed'::identity.provisioning_state
       OR account_observed_at IS NOT NULL;

CREATE UNIQUE INDEX uq_custody_key_current_provisioning_role
    ON identity.custody_key_reference (provisioning_id, authority_role)
    WHERE state IN (
        'generated'::identity.custody_key_state,
        'active'::identity.custody_key_state,
        'destruction_requested'::identity.custody_key_state
    );

CREATE UNIQUE INDEX uq_custody_key_current_player_role
    ON identity.custody_key_reference (player_id, authority_role)
    WHERE player_id IS NOT NULL
      AND state IN (
          'generated'::identity.custody_key_state,
          'active'::identity.custody_key_state,
          'destruction_requested'::identity.custody_key_state
      );

CREATE UNIQUE INDEX uq_hive_account_claim_one_pending_player
    ON identity.hive_account_claim (player_id)
    WHERE state IN (
        'requested'::identity.claim_state,
        'authority_rotation_pending'::identity.claim_state,
        'custody_destruction_pending'::identity.claim_state,
        'recovery_change_pending'::identity.claim_state,
        'retryable_failed'::identity.claim_state
    );

CREATE UNIQUE INDEX uq_auth_session_one_open_per_player
    ON identity.auth_session (player_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX uq_lobby_membership_one_open_per_player
    ON game.lobby_membership (player_id)
    WHERE left_at IS NULL;

CREATE UNIQUE INDEX uq_lobby_one_current_host_assignment
    ON game.lobby_host_assignment (lobby_id)
    WHERE ended_at IS NULL;

CREATE UNIQUE INDEX uq_friend_request_one_pending_pair
    ON social.friend_request (
        LEAST(requester_player_id, recipient_player_id),
        GREATEST(requester_player_id, recipient_player_id)
    )
    WHERE status = 'pending'::social.friend_request_status;

CREATE UNIQUE INDEX uq_lobby_invitation_one_pending_invitee
    ON social.lobby_invitation (lobby_id, invitee_player_id)
    WHERE status = 'pending'::social.invitation_status;

CREATE INDEX idx_lobby_open_public_region
    ON game.lobby (region_code, created_at DESC)
    WHERE closed_at IS NULL
      AND visibility = 'public'::game.lobby_visibility;

CREATE UNIQUE INDEX uq_map_version_one_package
    ON content.map_asset (map_version_id)
    WHERE kind = 'package'::content.map_asset_kind;

CREATE UNIQUE INDEX uq_loadout_one_active_item_per_slot
    ON commerce.player_loadout (player_id, equipment_slot)
    WHERE unequipped_at IS NULL;

CREATE UNIQUE INDEX uq_loadout_one_active_use_per_instance
    ON commerce.player_loadout (collectible_instance_id)
    WHERE unequipped_at IS NULL;

CREATE UNIQUE INDEX uq_payment_one_open_correlation
    ON commerce.payment_transaction (correlation_reference)
    WHERE correlation_reference IS NOT NULL
      AND state IN (
          'requested'::commerce.payment_state,
          'awaiting_signature'::commerce.payment_state,
          'broadcast'::commerce.payment_state,
          'included'::commerce.payment_state
      );

CREATE UNIQUE INDEX uq_rc_delegation_one_active_scope
    ON hive_projection.rc_delegation
       (delegator_hive_account, recipient_hive_username, purpose)
    WHERE status IN (
        'pending'::hive_projection.rc_delegation_status,
        'active'::hive_projection.rc_delegation_status,
        'reclaiming'::hive_projection.rc_delegation_status
    );

CREATE UNIQUE INDEX uq_block_checkpoint_current_height
    ON hive_projection.block_checkpoint (source, block_number)
    WHERE state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_hive_operation_current_source_id
    ON hive_projection.operation (source_operation_id)
    WHERE state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_hive_operation_current_tx_index
    ON hive_projection.operation (transaction_id, operation_index)
    WHERE transaction_id IS NOT NULL
      AND state <> 'reverted'::hive_projection.operation_state;

CREATE UNIQUE INDEX uq_platform_role_approval_one_pending
    ON identity.platform_role_approval (
      target_player_id,
      role,
      scope_type,
      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE state = 'pending'::identity.role_approval_state;
```

`hive_account_provisioning.external_identity_id` is a full unique constraint rather than a partial index: the design retains and retries one logical job for the lifetime of the external identity, including its completed outcome. A separate result-chain-head index is unnecessary because one revision number per round, exactly one revision-one initial row, noninitial previous edges, and unique `previous_revision_id` produce one chain; its only leaf is the head. Those cross-row assumptions still require the triggers below.

An active-showcase uniqueness rule may be added when the publication workflow is finalized. It should use a partial unique index rather than preventing retained historical drafts and failures.

### 10.2 Required triggers or equivalent transactional service guarantees

- Increment `row_version` and refresh `updated_at` on optimistic-lock aggregates.
- Enforce non-overlapping unrevoked platform-role validity, exact typed scope existence, matching
  append-only grant/revocation audit evidence, and an unexpired independent approval for
  administrator/auditor grants or extensions.
- Retain both branches of a Hive fork through block checkpoints, allow only one non-reverted
  checkpoint per source/height, bind each raw operation to its exact checkpoint, and scope source
  and transaction-position deduplication to non-reverted operations so replacement branches can
  reuse their Hive identities without deleting old evidence. Retain rejected operation evidence
  and prevent any irreversible checkpoint/operation from being reverted.
- Treat `hive_account_provisioning.external_identity_id` as the serialized idempotency root. Make the requested username immutable after a matching account is observed; reconcile uncertain creation by account name and all expected public authorities before linking.
- Require exactly one nondestroyed owner, active, posting, and memo `custody_key_reference` before `keys_ready`; only the custody adapter may transition destruction state/evidence. A `ready` transaction links the same external identity/job/username, player, and initial RC row.
- Prevent creation of a playable Google `player` or `auth_session` before account/authority/RC verification. Never synthesize a guest identity for an incomplete job.
- Require the claim's `change_recovery_account` and `account_update2` operations to share one transaction and use the current custodied owner key for that same player. The target recovery account must pass the separately approved non-platform policy.
- Do not disable custodial signing or destroy any key until authority rotation is irreversible, all target authorities match current Hive state, and the pending recovery request is verified. Require all four destruction completions before `recovery_change_pending`; require the effective account state and `changed_recovery_account` virtual operation before `self_custody_complete`.
- When authority rotation is verified, atomically change `player.hive_control_state`, revoke custodial eligibility on open sessions, and reject/cancel outstanding custodial intents before key destruction. Later operations must use an external signer even while recovery remains pending.
- Prevent mutation/deletion of completed round headers and detailed result children. All corrections and invalidations append revisions.
- Require an initial `round_result_revision` to match `game_round.result_schema_version`, `scoring_rule_version`, and `canonical_result_sha256`. Require every later revision's previous row to belong to the same round, increment by one, and have no existing child.
- Commit the completed detailed result and initial exact canonical revision atomically. Aborted/incomplete rounds cannot receive terminal result rows.
- Require stored canonical result bytes to be nonempty, bounded, and exactly match their SHA-256. Initial and correction revisions require bytes; invalidations do not.
- Verify sponsor-backed initial RC against the configured sponsor account/policy, exact recipient,
  minimum max-RC, expected operation schema, and irreversibility. Require the sponsor delegator
  kind and no platform service role for initial provisioning; require the separate RC-support
  role for later platform assistance/reclaim.
- Prevent mutation of a submitted map version's identity, manifest, package, and asset content; permit only controlled review/status timestamp transitions. A content change creates a new version.
- Keep the open `lobby_host_assignment` and `lobby.current_host_player_id` synchronized.
- Validate that the current host and every round participant belong to the relevant lobby lifecycle.
- Require at least two active players and enforce `hunter_count < active_player_count`, leaving at least one Hunter and one Hider.
- Require exactly `hunter_count` initial Hunters in the completed participant set and allow no more than the approved maximum of two.
- Require `auto_start_threshold <= lobby.max_players`; cancel the visible automatic-start countdown if active membership falls below the threshold.
- Permit a round to start only when its exact map version has an available distribution for the requesting platform/build.
- Validate discovery roles and Infection conversion order against the completed result snapshot.
- Validate that a round-like target was a Hider and the voter was eligible.
- Permit lobby selection only when the map, exact version, and target-platform distribution are all available.
- Require a creator-facing reason for map suspension/removal and retain an append-only lifecycle event.
- Keep the previous approved map distribution available until a replacement version passes review, then activate the replacement transactionally.
- Create a Hive map-showcase vote intent only after the voter has a valid completed participation whose current result-revision chain is not invalidated.
- Materialize or revoke a collectible instance only when the accepted event type, instance UUID, item-definition UUID, issuer, and owner Hive username match the domain records exactly.
- Permit loadout activation only when the instance belongs to the player, is finalized, is not revoked, and matches the slot.
- Fulfill a purchase only after irreversible payment evidence and irreversible collectible issuance.
- Accept a tournament entry only after the exact incoming payment is finalized.
- Ensure a tournament-match winner participated in that match and every match entry belongs to the same tournament.
- Ensure percentage prize rules form an allowed split and payouts do not exceed the verified pot.
- Mark a payout paid only after its outgoing payment is irreversible.

State transitions should be implemented as explicit domain commands, not unrestricted generic row updates.

### 10.3 Transaction isolation and idempotency

- Login replacement, Google provisioning, account claim, host migration, lobby start, round finalization, purchase fulfillment, collectible projection, tournament entry, and payout completion require transaction-level idempotency.
- Create the private `game.round_live_checkpoint` atomically with the round header. Nakama updates it
  with an `updated_at` compare-and-swap after authoritative commands and state transitions, plus a
  one-second heartbeat. `MatchInit` must reject an active round whose checkpoint is missing,
  unsupported, malformed, or concurrently owned by a newer handler.
- Derive process-crash reconnect deadlines from the last persisted heartbeat, never from the time a
  client first asks to reconnect. Rehydration checkpoints those reservations before accepting a
  join, so repeated restarts cannot extend the 60-second outcome-preservation window.
- Let `hc_api` execute only the authenticated reconnect-descriptor function. Keep direct
  `game.round_live_checkpoint` reads exclusive to `hc_nakama`; the descriptor contains no role,
  score, round ID, other-player state, or raw checkpoint JSON.
- Delete the private checkpoint in the same transaction that commits a terminal result, and delete
  it when a lobby-closing transaction aborts the round. It is operational recovery state, not
  completed history.
- Use row locks or serializable transactions for external-identity provisioning ownership, username/job transitions, claim state, lobby capacity, purchase limits, host replacement, correction-chain append, bracket advancement, and payout allocation.
- Non-virtual chain operations are deduplicated by transaction ID plus operation index; every projected row, including `changed_recovery_account` virtual operations, also has a stable HAF/HAfAH source operation ID. Provisioning, claim, transaction-intent, and application-event identities remain stable across retries.
- A Hive fork may revert an included projection and return a provisioning or application-event workflow to reconciliation. Only irreversible ownership and payment evidence is final.

## 11. Retention and scaling posture

### 11.1 Long-lived records

Retain external identity mappings needed for continuity; completed provisioning outcomes; non-secret custody-key lifecycle/destruction evidence; claim and recovery-transition history; player/profile identity; completed and aborted round headers; immutable detailed results and revisions; maps and versions; review history; collectible ownership evidence; purchases; tournament records; payments; RC delegation evidence; and relevant Hive projections. These records support history, verification, cache rebuilding, reconciliation, and dispute investigation.

### 11.2 Operationally expirable records

Expired/revoked sessions, lobby access tokens, invitations, read notifications, and expired/failed transaction-intent retry details can be archived or purged by scheduled policy after their troubleshooting window. Provisioning and official-event retry telemetry may be compacted only after the immutable outcome and chain references remain reconstructable. Raw secrets are never retained for audit. The [non-functional requirements](../non-functional-requirements.md) set the security-audit minimum; remaining domain-record durations require an approved retention policy before production.

### 11.3 Initial scaling decision

Do not partition tables for the first implementation. The expected vertical-slice volume does not justify the operational cost. Monitor `game.game_round`, `game.round_participant`, `game.round_result_revision`, `social.notification`, `commerce.payment_transaction`, `hive_projection.operation`, and collectible/payment projections. Introduce time/range partitioning only when measured size, retention maintenance, or query latency requires it; event time or Hive block number are the likely future keys.

Read replicas and caches may accelerate public profiles, map browsing, and history, but all writes continue through authoritative services. Redis may cache discovery and presence but must not become the only copy of durable facts.

## 12. Scope coverage and deferred expansion

The model is deliberately broad enough to support the approved P0/P1 product flow while keeping later features isolated:

- The direct/Google identity lifecycle, lobby, game-round/revision, map,
  profile, reconnect outcome markers, and other Hive projection structures are represented. The
  private active-round checkpoint durably carries the current 60-second reconnect deadline while
  sockets and online presence remain outside PostgreSQL.
- Friends, Streamer Mode, cosmetics/shop, and controlled tournament payments are represented without forcing all of them into the first gameplay milestone.
- Creator Workshop tables support reviewed community map versions and controlled desktop distribution when that track is activated.
- External payment rails, additional tournament formats, and richer creator workflows can extend existing commerce/content structures.
- Mobile-specific settings, built-in communication, seasonal rankings, and collectible transfer/resale are not represented.

### 12.1 Open decisions preserved by the model

- Google-account loss and identity-recovery behavior.
- Whether and how a pre-existing Hive account can be linked to Google.
- Google issuer/subject relinking or replacement.
- Whether Google remains an accepted game-session credential after self-custody claim.
- Production custody-provider selection after the required capability/feasibility/cost spike.
- Signup-sponsor selection, exact account-creation/RC contract, creator/recovery account,
  signup-code policy, capacity signal, and minimum initial RC.
- Exact valid non-platform recovery-account selection and proof policy.
- Exact player-facing claim and self-custodial credential UI.
- Initial/general RC amounts, eligibility thresholds, cooldowns, and reclaim policy.
- Production Hive service-account names and operational custody procedures.
- Final approval of the provisional `hive.chameleon` application namespace.

Human, resource-scoped, and service permissions are defined in the
[roles and permissions design](../roles-and-permissions.md). Durable platform-role assignments,
independent high-risk approvals, and append-only authorization audit events are implemented here;
reviewer and issuer references alone do not grant authorization.

## 13. Validation and usage

Import `hive-chameleon.dbml` into [dbdiagram.io](https://dbdiagram.io/) or another
DBML-compatible renderer to inspect the ERD. From the repository root, validate and export it with:

```bash
NPM_CONFIG_CACHE=/tmp/npm-cache \
  npx --yes --package @dbml/cli \
  dbml2sql docs/technical-specification/data-model/hive-chameleon.dbml --postgres \
  -o /tmp/hive-chameleon.sql
```

The source currently compiles successfully with the DBML CLI. A successful export validates DBML
syntax and relationship resolution. The ordered release schema lives in
`infra/postgres/migrations`; it adds the partial indexes, triggers, security roles, and extensions
that DBML cannot express. `infra/postgres/compose.yaml` applies those migrations to a clean
PostgreSQL 17 database and runs the executable schema/constraint tests.

## 14. Implemented scope

- Core product entities are represented in PostgreSQL-oriented DBML with primary keys, foreign
  keys, cardinalities, enums, indexes, and checks.
- Direct-Hive and Google identity, pending provisioning, custody references, and claim/recovery
  have explicit boundaries without stored secrets.
- Exact canonical result bytes, detailed evidence, and append-only revisions have explicit local
  authority and integrity boundaries.
- Collectible ownership, community posts/votes, sponsor-backed initial RC, later RC support, and
  payment projections have explicit authority boundaries.
- Full live Nakama/Redis state and object-storage content are excluded from relational persistence;
  PostgreSQL stores only the private, versioned active-round recovery checkpoint needed to restore
  authoritative outcomes after a Nakama process restart.
- Completed versus aborted round persistence, map version/review/distribution, and tournament
  entry/scoring/payment/payout relationships are modeled.
- PostgreSQL-only integrity rules are executable migrations and tests, and the DBML source exports
  successfully to PostgreSQL SQL.
