import type { OfficialEventIntent, OfficialServiceAuthorization } from '../contracts.js';
import type { MatchEvent } from '../protocol/match.js';

export const MANAGED_SIGNING_FIXTURE = {
  digest: '23b62f08f440d24db93bbd61e1a902b9807ce6d4d3a63be80569575651699234',
  signature:
    '204486a65bbc34a4d7cacf14ca4fb255ba31a0620ffa9cbd1d1546c8ea839b9abe0f4949c525dbd7105f61d7176348a8a7df68dff90b49b7e58a5660906620f856',
  publicKey: 'STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET',
} as const;

export const MATCH_EVENT_FIXTURE: MatchEvent = {
  v: 1,
  type: 'match_results_batch',
  event_version: 1,
  event_id: '0190f6d2-7c00-7000-8000-000000000001',
  occurred_at: '2026-07-11T12:05:00.000Z',
  data: {
    batch_id: '0190f6d2-7c00-7000-8000-000000000002',
    period_start: '2026-07-11T12:00:00.000Z',
    period_end: '2026-07-11T12:05:00.000Z',
    publisher: 'match-pub',
    result_count: 1,
    results: [
      {
        round_id: '0190f6d2-7c00-7000-8000-000000000003',
        completed_at: '2026-07-11T12:03:42.000Z',
        context: 'normal',
        mode: 'infection',
        result_schema: 'match-result-1',
        scoring_rules: 'scoring-1',
        map: {
          map_id: '0190f6d2-7c00-7000-8000-000000000004',
          version_id: '0190f6d2-7c00-7000-8000-000000000005',
          version: '1.0.0',
          content_sha256: 'a'.repeat(64),
        },
        server: { build: 'game-server-0.1.0', protocol: 'match-1' },
        winning_side: 'hiders',
        winner_accounts: ['alice'],
        participants: [
          {
            account: 'alice',
            initial_role: 'hider',
            final_role: 'hider',
            outcome: 'survived',
            score: '1250.0000',
          },
          {
            account: 'bobby',
            initial_role: 'hunter',
            final_role: 'hunter',
            outcome: 'hunter_loss',
            score: '900.0000',
          },
        ],
        discoveries: [],
        survivors: ['alice'],
        likes: [{ account: 'alice', received: 1 }],
        result_sha256: 'b'.repeat(64),
      },
    ],
  },
};

export const MATCH_AUTHORIZATION_FIXTURE: OfficialServiceAuthorization = {
  mode: 'official_service',
  role: 'match_publisher',
  account: 'match-pub',
  authority: 'posting',
  expectedPublicKey: MANAGED_SIGNING_FIXTURE.publicKey,
  signerKeyReference: 'fixture/match-publisher/posting',
  policyVersion: 'match-policy-1',
};

export const MATCH_INTENT_FIXTURE: OfficialEventIntent = {
  idempotencyKey: 'match-batch:0190f6d2-7c00-7000-8000-000000000002',
  policyVersion: 'match-policy-1',
  event: MATCH_EVENT_FIXTURE,
};
