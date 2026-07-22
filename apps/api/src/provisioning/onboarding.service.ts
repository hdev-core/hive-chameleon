import { createHash } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  HIVE_POSTING_AUTHORITY_VERIFIER,
  type HivePostingAuthorityVerifier,
} from '../auth/auth.types';
import type { OnboardingConfig } from './onboarding.config';
import type { PostgresOnboardingRepository } from './onboarding.repository';
import { type ProvisioningStatus } from './onboarding.repository';

@Injectable()
export class OnboardingService {
  public constructor(
    private readonly repository: PostgresOnboardingRepository,
    @Inject(HIVE_POSTING_AUTHORITY_VERIFIER)
    private readonly hive: HivePostingAuthorityVerifier,
    private readonly config: OnboardingConfig | null,
  ) {}

  public async checkUsername(hiveUsername: string): Promise<{
    readonly available: boolean;
    readonly checkedAt: string;
    readonly hiveUsername: string;
    readonly reservationCreated: false;
    readonly unavailableReason?: 'exists_on_hive' | 'pending_platform_job';
  }> {
    const checkedAt = new Date();
    const [existsOnHive, pending] = await Promise.all([
      this.hive.usernameExists(hiveUsername),
      this.repository.isUsernamePending(hiveUsername),
    ]);
    return {
      available: !existsOnHive && !pending,
      checkedAt: checkedAt.toISOString(),
      hiveUsername,
      reservationCreated: false,
      ...(existsOnHive
        ? { unavailableReason: 'exists_on_hive' as const }
        : pending
          ? { unavailableReason: 'pending_platform_job' as const }
          : {}),
    };
  }

  public async confirmUsername(
    externalIdentityId: string,
    hiveUsername: string,
    idempotencyKey: string,
  ): Promise<ProvisioningStatus> {
    const config = this.requireConfiguration();
    const availability = await this.checkUsername(hiveUsername);
    const existing = await this.repository.findForIdentity(externalIdentityId);
    if (!availability.available && existing?.requestedHiveUsername !== hiveUsername) {
      throw new ConflictException({
        code: availability.unavailableReason ?? 'username_unavailable',
        detail: 'The Hive username is no longer available.',
        status: 409,
        title: 'Username unavailable',
      });
    }
    const scopedIdempotencyKey = createHash('sha256')
      .update(externalIdentityId)
      .update('\0')
      .update(idempotencyKey)
      .digest('hex');
    try {
      return await this.repository.confirmUsername({
        config,
        externalIdentityId,
        hiveUsername,
        idempotencyKey: scopedIdempotencyKey,
        now: new Date(),
      });
    } catch (error: unknown) {
      if (error instanceof ConflictException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ConflictException({
        code: 'onboarding_conflict',
        detail: 'This onboarding identity already has a different permanent selection.',
        status: 409,
        title: 'Onboarding conflict',
      });
    }
  }

  public async start(externalIdentityId: string): Promise<ProvisioningStatus> {
    this.requireConfiguration();
    const status = await this.repository.findForIdentity(externalIdentityId);
    if (!status) {
      throw provisioningNotFound();
    }
    return status;
  }

  public async getStatus(
    externalIdentityId: string,
    provisioningId: string,
  ): Promise<ProvisioningStatus> {
    const status = await this.repository.findByIdForIdentity(provisioningId, externalIdentityId);
    if (!status) {
      throw provisioningNotFound();
    }
    return status;
  }

  private requireConfiguration(): OnboardingConfig {
    if (!this.config) {
      throw new ServiceUnavailableException({
        code: 'provisioning_provider_unavailable',
        detail:
          'Google-to-Hive provisioning is paused until approved sponsor and custody adapters are configured.',
        status: 503,
        title: 'Provisioning unavailable',
      });
    }
    return this.config;
  }
}

function provisioningNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'provisioning_not_found',
    detail: 'No provisioning operation is visible for this onboarding identity.',
    status: 404,
    title: 'Not found',
  });
}
