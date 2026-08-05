import type { BridgePrincipal } from '../realtime/bridge-assertion';

export type ClientPlatform = 'webgl' | 'windows' | 'macos' | 'linux';
export type ExternalSigningProvider = 'keychain' | 'hiveauth' | 'hivesigner';

export interface PlayerIdentity {
  readonly id: string;
  readonly hiveControlState:
    | 'external_self_custodial'
    | 'platform_custodial'
    | 'authority_claimed_recovery_pending'
    | 'self_custody_complete';
  readonly hiveUsername: string;
}

export interface HiveLoginChallengeRecord {
  readonly challenge: string;
  readonly expiresAt: Date;
  readonly hiveUsername: string;
  readonly id: string;
  readonly platform: ClientPlatform;
}

export interface ExternalIdentityRecord {
  readonly id: string;
  readonly player: PlayerIdentity | null;
  readonly status: 'provisioning' | 'linked' | 'disabled';
}

export interface ActiveSessionRecord extends BridgePrincipal {
  readonly expiresAt: Date;
  readonly player: PlayerIdentity;
}

export interface NewSession {
  readonly authenticationMethod: 'direct_hive_challenge' | 'google_oidc';
  readonly custodialSigningEligible: boolean;
  readonly expiresAt: Date;
  readonly externalIdentityId: string | null;
  readonly hiveSigningProvider: ExternalSigningProvider | 'custodial_service' | null;
  readonly id: string;
  readonly issuedAt: Date;
  readonly platform: ClientPlatform;
  readonly player: PlayerIdentity;
  readonly refreshTokenHash: string;
}

export interface AuthRepository {
  createHiveChallenge(
    record: HiveLoginChallengeRecord & {
      readonly challengeSha256: string;
      readonly deviceSessionId: string;
      readonly issuedAt: Date;
    },
  ): Promise<void>;
  consumeHiveChallenge(
    challengeId: string,
    hiveUsername: string,
    consumedAt: Date,
  ): Promise<HiveLoginChallengeRecord | null>;
  findOrCreateDirectHivePlayer(hiveUsername: string): Promise<PlayerIdentity>;
  createSession(session: NewSession): Promise<void>;
  rotateSession(
    currentRefreshTokenHash: string,
    nextRefreshTokenHash: string,
    usedAt: Date,
  ): Promise<ActiveSessionRecord | null>;
  findActiveSession(sessionId: string, at: Date): Promise<ActiveSessionRecord | null>;
  revokeSession(sessionId: string, revokedAt: Date, reason: string): Promise<boolean>;
  upsertGoogleIdentity(
    verifiedIssuer: string,
    subjectLookupHash: string,
    authenticatedAt: Date,
  ): Promise<ExternalIdentityRecord>;
}

export interface HivePostingAuthorityVerifier {
  verify(input: {
    readonly challenge: string;
    readonly hiveUsername: string;
    readonly signature: string;
  }): Promise<boolean>;
  usernameExists(hiveUsername: string): Promise<boolean>;
}

export interface GoogleIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface GoogleOidcGateway {
  exchange(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<GoogleIdentity>;
}

export interface AuthHttpRequest {
  authPrincipal?: ActiveSessionRecord;
  headers: Record<string, string | string[] | undefined>;
}

export interface OnboardingPrincipal {
  readonly externalIdentityId: string;
}

export interface OnboardingHttpRequest extends AuthHttpRequest {
  onboardingPrincipal?: OnboardingPrincipal;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');
export const HIVE_POSTING_AUTHORITY_VERIFIER = Symbol('HIVE_POSTING_AUTHORITY_VERIFIER');
export const GOOGLE_OIDC_GATEWAY = Symbol('GOOGLE_OIDC_GATEWAY');
