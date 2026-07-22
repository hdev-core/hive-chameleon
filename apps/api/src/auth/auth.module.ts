import { Module } from '@nestjs/common';

import { DatabaseConnection } from '../database/database.connection';
import { AccessSessionGuard } from './access-session.guard';
import { loadAuthConfig, type AuthConfig } from './auth.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  AUTH_CONFIG,
  AUTH_REPOSITORY,
  GOOGLE_OIDC_GATEWAY,
  HIVE_POSTING_AUTHORITY_VERIFIER,
} from './auth.types';
import { GoogleAuthLibraryOidcGateway } from './google-oidc.gateway';
import { DisclosureController } from './disclosure.controller';
import { DisclosurePrincipalGuard } from './disclosure-principal.guard';
import { DisclosureService } from './disclosure.service';
import { RpcHivePostingAuthorityVerifier } from './hive-posting-authority.verifier';
import { OnboardingSessionGuard } from './onboarding-session.guard';
import { PostgresAuthRepository } from './postgres-auth.repository';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, DisclosureController],
  exports: [
    AccessSessionGuard,
    OnboardingSessionGuard,
    TokenService,
    AUTH_REPOSITORY,
    HIVE_POSTING_AUTHORITY_VERIFIER,
  ],
  providers: [
    { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
    {
      inject: [DatabaseConnection],
      provide: AUTH_REPOSITORY,
      useFactory: (database: DatabaseConnection) => new PostgresAuthRepository(database.pool),
    },
    {
      inject: [AUTH_CONFIG],
      provide: HIVE_POSTING_AUTHORITY_VERIFIER,
      useFactory: (config: AuthConfig) => new RpcHivePostingAuthorityVerifier(config),
    },
    {
      inject: [AUTH_CONFIG],
      provide: GOOGLE_OIDC_GATEWAY,
      useFactory: (config: AuthConfig) => new GoogleAuthLibraryOidcGateway(config.google),
    },
    AccessSessionGuard,
    AuthService,
    DisclosurePrincipalGuard,
    DisclosureService,
    OnboardingSessionGuard,
    TokenService,
  ],
})
export class AuthModule {}
