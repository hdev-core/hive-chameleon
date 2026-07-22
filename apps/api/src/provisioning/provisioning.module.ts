import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import {
  HIVE_POSTING_AUTHORITY_VERIFIER,
  type HivePostingAuthorityVerifier,
} from '../auth/auth.types';
import { DatabaseConnection } from '../database/database.connection';
import { loadOnboardingConfig, type OnboardingConfig } from './onboarding.config';
import { OnboardingController } from './onboarding.controller';
import { PostgresOnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';

const ONBOARDING_CONFIG = Symbol('ONBOARDING_CONFIG');

@Module({
  controllers: [OnboardingController],
  imports: [AuthModule],
  providers: [
    { provide: ONBOARDING_CONFIG, useFactory: loadOnboardingConfig },
    {
      inject: [DatabaseConnection],
      provide: PostgresOnboardingRepository,
      useFactory: (database: DatabaseConnection) => new PostgresOnboardingRepository(database.pool),
    },
    {
      inject: [PostgresOnboardingRepository, HIVE_POSTING_AUTHORITY_VERIFIER, ONBOARDING_CONFIG],
      provide: OnboardingService,
      useFactory: (
        repository: PostgresOnboardingRepository,
        hive: HivePostingAuthorityVerifier,
        config: OnboardingConfig | null,
      ) => new OnboardingService(repository, hive, config),
    },
  ],
})
export class ProvisioningModule {}
