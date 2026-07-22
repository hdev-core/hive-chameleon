export type HiveAuthorityRole = 'owner' | 'active' | 'posting' | 'memo';
export type ProvisioningState =
  | 'username_confirmed'
  | 'keys_ready'
  | 'account_creation_pending'
  | 'account_created'
  | 'rc_delegation_pending'
  | 'rc_delegated'
  | 'ready'
  | 'retryable_failed'
  | 'terminal_failed';

export interface ProvisioningJob {
  readonly externalIdentityId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestedHiveUsername: string;
  readonly sponsorHiveAccount: string;
  readonly sponsorPolicyVersion: string;
  readonly sponsorProgram: string;
  readonly state: ProvisioningState;
}

export interface CustodyKeyReference {
  readonly authorityRole: HiveAuthorityRole;
  readonly hivePublicKey: string;
  readonly providerKeyReference: string;
}

export interface ProvisioningRepository {
  getJobForUpdate(provisioningId: string): Promise<ProvisioningJob | null>;
  getKeys(provisioningId: string): Promise<readonly CustodyKeyReference[]>;
  saveKeys(provisioningId: string, keys: readonly CustodyKeyReference[], at: Date): Promise<void>;
  markAccountCreationPending(
    provisioningId: string,
    sponsorRequestReference: string,
    at: Date,
  ): Promise<void>;
  markAccountCreated(
    provisioningId: string,
    transactionId: string,
    observedAt: Date,
  ): Promise<void>;
  markRcDelegationPending(provisioningId: string, at: Date): Promise<void>;
  markRcDelegated(provisioningId: string, delegationReference: string, at: Date): Promise<void>;
  markReady(provisioningId: string, at: Date): Promise<void>;
  markRetryableFailure(provisioningId: string, safeFailureCode: string, at: Date): Promise<void>;
}

export interface CustodyProvisioningProvider {
  generateAuthorityKeys(input: {
    readonly idempotencyKey: string;
    readonly provisioningId: string;
    readonly roles: readonly HiveAuthorityRole[];
  }): Promise<readonly CustodyKeyReference[]>;
}

export interface SignupSponsorProvider {
  createClaimedAccount(input: {
    readonly accountCreationMethod: 'claim_account_create_claimed_account';
    readonly idempotencyKey: string;
    readonly keys: Readonly<Record<HiveAuthorityRole, string>>;
    readonly policyVersion: string;
    readonly sponsorHiveAccount: string;
    readonly username: string;
  }): Promise<{
    readonly requestReference: string;
    readonly transactionId: string;
  }>;
  delegateInitialResourceCredits(input: {
    readonly idempotencyKey: string;
    readonly policyVersion: string;
    readonly sponsorHiveAccount: string;
    readonly username: string;
  }): Promise<{ readonly delegationReference: string }>;
}

export interface ProvisioningChainVerifier {
  verifyReady(input: {
    readonly expectedKeys: Readonly<Record<HiveAuthorityRole, string>>;
    readonly sponsorHiveAccount: string;
    readonly username: string;
  }): Promise<{
    readonly accountIrreversible: boolean;
    readonly authoritiesMatch: boolean;
    readonly initialResourceCreditsReady: boolean;
  }>;
}

export class RetryableProvisioningError extends Error {
  public constructor(public readonly safeCode: string) {
    super(safeCode);
    this.name = 'RetryableProvisioningError';
  }
}
