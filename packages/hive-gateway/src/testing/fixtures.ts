import type { OfficialEventIntent, OfficialServiceAuthorization } from '../contracts.js';
import type { CollectibleEvent } from '../protocol/collectible.js';

export const MANAGED_SIGNING_FIXTURE = {
  digest: '23b62f08f440d24db93bbd61e1a902b9807ce6d4d3a63be80569575651699234',
  signature:
    '204486a65bbc34a4d7cacf14ca4fb255ba31a0620ffa9cbd1d1546c8ea839b9abe0f4949c525dbd7105f61d7176348a8a7df68dff90b49b7e58a5660906620f856',
  publicKey: 'STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET',
} as const;

export const COLLECTIBLE_EVENT_FIXTURE: Extract<CollectibleEvent, { type: 'collectible_issued' }> =
  {
    v: 1,
    type: 'collectible_issued',
    event_id: '0190f6d2-7c00-7000-8000-000000000001',
    occurred_at: '2026-07-11T12:05:00.000Z',
    data: {
      collectible_id: '0190f6d2-7c00-7000-8000-000000000002',
      definition_id: 'founder.badge',
      kind: 'badge',
      owner: 'alice',
      issuer: 'item-issuer',
      reason: 'founder_reward',
      metadata_uri: 'https://assets.example/collectibles/founder.json',
      metadata_sha256: 'a'.repeat(64),
    },
  };

export const COLLECTIBLE_AUTHORIZATION_FIXTURE: OfficialServiceAuthorization = {
  mode: 'official_service',
  role: 'collectible_issuer',
  account: 'item-issuer',
  authority: 'posting',
  expectedPublicKey: MANAGED_SIGNING_FIXTURE.publicKey,
  signerKeyReference: 'fixture/collectible-issuer/posting',
  policyVersion: 'collectible-policy-1',
};

export const COLLECTIBLE_INTENT_FIXTURE: OfficialEventIntent = {
  idempotencyKey: 'collectible:0190f6d2-7c00-7000-8000-000000000001:attempt:1',
  policyVersion: 'collectible-policy-1',
  event: COLLECTIBLE_EVENT_FIXTURE,
};
