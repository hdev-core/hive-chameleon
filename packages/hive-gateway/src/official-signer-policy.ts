import type {
  OfficialServiceAuthorization,
  OfficialServiceRole,
  OfficialSignerPolicy,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';

export class StaticOfficialSignerPolicy implements OfficialSignerPolicy {
  private readonly entries = new Map<string, OfficialServiceAuthorization>();

  public constructor(authorizations: readonly OfficialServiceAuthorization[]) {
    if (authorizations.length === 0) {
      throw new HiveGatewayError('invalid_authorization', 'Signer policy must not be empty');
    }

    for (const authorization of authorizations) {
      const key = policyKey(authorization.policyVersion, authorization.role);
      if (this.entries.has(key)) {
        throw new HiveGatewayError(
          'invalid_authorization',
          'Signer policy contains a duplicate role and version',
        );
      }
      this.entries.set(key, Object.freeze({ ...authorization }));
    }
  }

  public resolve(
    policyVersion: string,
    role: OfficialServiceRole,
  ): OfficialServiceAuthorization | null {
    return this.entries.get(policyKey(policyVersion, role)) ?? null;
  }
}

function policyKey(policyVersion: string, role: OfficialServiceRole): string {
  return `${policyVersion}\u0000${role}`;
}
