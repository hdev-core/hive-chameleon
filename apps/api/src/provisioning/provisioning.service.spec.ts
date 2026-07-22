import { describe, expect, it, vi } from 'vitest';

import { ProvisioningService } from './provisioning.service';
import {
  RetryableProvisioningError,
  type CustodyKeyReference,
  type ProvisioningJob,
  type ProvisioningRepository,
} from './provisioning.types';

const job: ProvisioningJob = {
  externalIdentityId: '01980abc-def1-7abc-8def-0123456789ab',
  id: '01980abc-def2-7abc-8def-0123456789ab',
  idempotencyKey: 'provisioning-logical-job',
  requestedHiveUsername: 'alice',
  sponsorHiveAccount: 'signup-sponsor',
  sponsorPolicyVersion: 'sponsor-1',
  sponsorProgram: 'approved-program',
  state: 'username_confirmed',
};
const keys: readonly CustodyKeyReference[] = [
  key('owner'),
  key('active'),
  key('posting'),
  key('memo'),
];

describe('ProvisioningService', () => {
  it('uses stable sub-operation keys and marks ready only after irreversible evidence', async () => {
    const repository = repositoryFake();
    const custody = { generateAuthorityKeys: vi.fn().mockResolvedValue(keys) };
    const sponsor = {
      createClaimedAccount: vi.fn().mockResolvedValue({
        requestReference: 'sponsor-request',
        transactionId: 'hive-transaction',
      }),
      delegateInitialResourceCredits: vi.fn().mockResolvedValue({
        delegationReference: 'delegation-reference',
      }),
    };
    const chain = {
      verifyReady: vi.fn().mockResolvedValue({
        accountIrreversible: true,
        authoritiesMatch: true,
        initialResourceCreditsReady: true,
      }),
    };

    const result = await new ProvisioningService(repository, custody, sponsor, chain).process(
      job.id,
      new Date('2026-07-23T00:00:00Z'),
    );

    expect(result.state).toBe('ready');
    expect(custody.generateAuthorityKeys).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'provisioning-logical-job:keys' }),
    );
    expect(sponsor.createClaimedAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountCreationMethod: 'claim_account_create_claimed_account',
        idempotencyKey: 'provisioning-logical-job:account',
      }),
    );
    expect(sponsor.delegateInitialResourceCredits).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'provisioning-logical-job:initial-rc' }),
    );
    expect(repository.markReady).toHaveBeenCalledOnce();
  });

  it('records a retryable state while Hive evidence is incomplete', async () => {
    const repository = repositoryFake();
    vi.mocked(repository.getKeys).mockResolvedValue(keys);
    const service = new ProvisioningService(
      repository,
      { generateAuthorityKeys: vi.fn() },
      {
        createClaimedAccount: vi.fn().mockResolvedValue({
          requestReference: 'sponsor-request',
          transactionId: 'hive-transaction',
        }),
        delegateInitialResourceCredits: vi.fn().mockResolvedValue({
          delegationReference: 'delegation-reference',
        }),
      },
      {
        verifyReady: vi.fn().mockResolvedValue({
          accountIrreversible: false,
          authoritiesMatch: true,
          initialResourceCreditsReady: true,
        }),
      },
    );

    await expect(service.process(job.id)).rejects.toBeInstanceOf(RetryableProvisioningError);
    expect(repository.markReady).not.toHaveBeenCalled();
    expect(repository.markRetryableFailure).toHaveBeenCalledWith(
      job.id,
      'hive_account_confirmation_pending',
      expect.any(Date),
    );
  });
});

function key(authorityRole: CustodyKeyReference['authorityRole']): CustodyKeyReference {
  return {
    authorityRole,
    hivePublicKey: `STM-${authorityRole}-public`,
    providerKeyReference: `opaque/${authorityRole}`,
  };
}

function repositoryFake(): ProvisioningRepository {
  return {
    getJobForUpdate: vi.fn().mockResolvedValue(job),
    getKeys: vi.fn().mockResolvedValue([]),
    markAccountCreated: vi.fn(),
    markAccountCreationPending: vi.fn(),
    markRcDelegated: vi.fn(),
    markRcDelegationPending: vi.fn(),
    markReady: vi.fn(),
    markRetryableFailure: vi.fn(),
    saveKeys: vi.fn(),
  };
}
