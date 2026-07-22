import type {
  CustodyKeyReference,
  CustodyProvisioningProvider,
  HiveAuthorityRole,
  ProvisioningChainVerifier,
  ProvisioningJob,
  ProvisioningRepository,
  SignupSponsorProvider,
} from './provisioning.types';
import { RetryableProvisioningError } from './provisioning.types';

const authorityRoles = ['owner', 'active', 'posting', 'memo'] as const;

/**
 * Durable, retry-safe Google-to-Hive provisioning coordinator. External adapters
 * must be approved independently; this service never owns sponsor or player keys.
 */
export class ProvisioningService {
  public constructor(
    private readonly repository: ProvisioningRepository,
    private readonly custody: CustodyProvisioningProvider,
    private readonly sponsor: SignupSponsorProvider,
    private readonly chain: ProvisioningChainVerifier,
  ) {}

  public async process(provisioningId: string, now = new Date()): Promise<ProvisioningJob> {
    const job = await this.repository.getJobForUpdate(provisioningId);
    if (!job) {
      throw new Error('Provisioning job does not exist.');
    }
    if (job.state === 'ready' || job.state === 'terminal_failed') {
      return job;
    }

    try {
      const keyReferences = await this.ensureKeys(job, now);
      const keys = keyMap(keyReferences);

      if (
        job.state === 'username_confirmed' ||
        job.state === 'keys_ready' ||
        job.state === 'account_creation_pending' ||
        job.state === 'retryable_failed'
      ) {
        const account = await this.sponsor.createClaimedAccount({
          accountCreationMethod: 'claim_account_create_claimed_account',
          idempotencyKey: `${job.idempotencyKey}:account`,
          keys,
          policyVersion: job.sponsorPolicyVersion,
          sponsorHiveAccount: job.sponsorHiveAccount,
          username: job.requestedHiveUsername,
        });
        await this.repository.markAccountCreationPending(job.id, account.requestReference, now);
        const accountVerification = await this.chain.verifyReady({
          expectedKeys: keys,
          sponsorHiveAccount: job.sponsorHiveAccount,
          username: job.requestedHiveUsername,
        });
        if (!accountVerification.accountIrreversible || !accountVerification.authoritiesMatch) {
          throw new RetryableProvisioningError('hive_account_confirmation_pending');
        }
        await this.repository.markAccountCreated(job.id, account.transactionId, now);
      }

      if (job.state !== 'rc_delegated') {
        await this.repository.markRcDelegationPending(job.id, now);
        const delegation = await this.sponsor.delegateInitialResourceCredits({
          idempotencyKey: `${job.idempotencyKey}:initial-rc`,
          policyVersion: job.sponsorPolicyVersion,
          sponsorHiveAccount: job.sponsorHiveAccount,
          username: job.requestedHiveUsername,
        });
        await this.repository.markRcDelegated(job.id, delegation.delegationReference, now);
      }

      const verification = await this.chain.verifyReady({
        expectedKeys: keys,
        sponsorHiveAccount: job.sponsorHiveAccount,
        username: job.requestedHiveUsername,
      });
      if (
        !verification.accountIrreversible ||
        !verification.authoritiesMatch ||
        !verification.initialResourceCreditsReady
      ) {
        throw new RetryableProvisioningError('hive_confirmation_pending');
      }
      await this.repository.markReady(job.id, now);
      return { ...job, state: 'ready' };
    } catch (error: unknown) {
      const safeCode =
        error instanceof RetryableProvisioningError
          ? error.safeCode
          : 'provisioning_provider_unavailable';
      await this.repository.markRetryableFailure(job.id, safeCode, now);
      throw error;
    }
  }

  private async ensureKeys(
    job: ProvisioningJob,
    now: Date,
  ): Promise<readonly CustodyKeyReference[]> {
    const existing = await this.repository.getKeys(job.id);
    if (existing.length === authorityRoles.length) {
      keyMap(existing);
      return existing;
    }
    if (existing.length !== 0) {
      throw new Error('Provisioning has an incomplete custody-key set.');
    }
    const generated = await this.custody.generateAuthorityKeys({
      idempotencyKey: `${job.idempotencyKey}:keys`,
      provisioningId: job.id,
      roles: authorityRoles,
    });
    keyMap(generated);
    await this.repository.saveKeys(job.id, generated, now);
    return generated;
  }
}

function keyMap(keys: readonly CustodyKeyReference[]): Readonly<Record<HiveAuthorityRole, string>> {
  const entries = new Map<HiveAuthorityRole, string>();
  for (const key of keys) {
    if (entries.has(key.authorityRole) || !key.hivePublicKey || !key.providerKeyReference) {
      throw new Error('Custody provider returned an invalid authority-key set.');
    }
    entries.set(key.authorityRole, key.hivePublicKey);
  }
  for (const role of authorityRoles) {
    if (!entries.has(role)) {
      throw new Error('Custody provider did not generate every required authority role.');
    }
  }
  return Object.fromEntries(entries) as Record<HiveAuthorityRole, string>;
}
