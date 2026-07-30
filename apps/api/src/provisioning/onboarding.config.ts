export interface OnboardingConfig {
  readonly sponsorHiveAccount: string;
  readonly sponsorPolicyVersion: string;
  readonly sponsorProgram: string;
}

export function loadOnboardingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OnboardingConfig | null {
  const values = {
    sponsorHiveAccount: environment.PROVISIONING_SPONSOR_HIVE_ACCOUNT?.trim(),
    sponsorPolicyVersion: environment.PROVISIONING_SPONSOR_POLICY_VERSION?.trim(),
    sponsorProgram: environment.PROVISIONING_SPONSOR_PROGRAM?.trim(),
  };
  if (Object.values(values).every((value) => !value)) {
    return null;
  }
  if (Object.values(values).some((value) => !value)) {
    throw new Error(
      'PROVISIONING_SPONSOR_HIVE_ACCOUNT, PROVISIONING_SPONSOR_POLICY_VERSION, and PROVISIONING_SPONSOR_PROGRAM must be configured together.',
    );
  }
  if (!/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.test(values.sponsorHiveAccount!)) {
    throw new Error('PROVISIONING_SPONSOR_HIVE_ACCOUNT must be a normalized Hive account.');
  }
  return values as OnboardingConfig;
}
