import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { AUTH_REPOSITORY, type AuthRepository } from './auth.types';

const disclosureTitle = 'Permanent Hive match-summary record';
const disclosureBody =
  'Published Hive match summaries permanently expose your Hive username, match participation, role, score, outcome, and aggregated likes. Hive records are public and cannot be removed by an off-chain deletion request.';
const permanentFields = [
  'hive_username',
  'match_participation',
  'role',
  'score',
  'outcome',
  'aggregated_likes',
] as const;
const expectedContentSha256 = '64ae0b7b385c6f4c1287e25979c44fce05c51583f61f20c7bb7e31171d921cc3';

@Injectable()
export class DisclosureService {
  public constructor(@Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository) {}

  public async getCurrent(now = new Date()) {
    const disclosure = await this.repository.getCurrentDisclosure(now);
    if (!disclosure || disclosure.contentSha256 !== expectedContentSha256) {
      throw disclosureUnavailable();
    }
    return {
      body: disclosureBody,
      contentSha256: disclosure.contentSha256,
      effectiveAt: disclosure.effectiveAt.toISOString(),
      permanentFields,
      title: disclosureTitle,
      version: disclosure.version,
    };
  }

  public async acknowledge(
    input: {
      readonly contentSha256: string;
      readonly disclosureVersion: string;
      readonly externalIdentityId: string | null;
      readonly playerId: string | null;
    },
    now = new Date(),
  ) {
    if ((input.externalIdentityId === null) === (input.playerId === null)) {
      throw new Error('Exactly one disclosure subject is required.');
    }
    const current = await this.getCurrent(now);
    if (
      input.disclosureVersion !== current.version ||
      input.contentSha256 !== current.contentSha256
    ) {
      throw new ConflictException({
        code: 'disclosure_version_changed',
        detail:
          'The disclosure changed before acknowledgment. Fetch and review the current version.',
        status: 409,
        title: 'Disclosure changed',
      });
    }
    const acknowledgment = await this.repository.acknowledgeCurrentDisclosure({
      ...input,
      acknowledgedAt: now,
    });
    if (!acknowledgment) {
      throw disclosureUnavailable();
    }
    return {
      acknowledgedAt: acknowledgment.acknowledgedAt.toISOString(),
      disclosureVersion: acknowledgment.disclosureVersion,
      id: acknowledgment.id,
    };
  }
}

function disclosureUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'public_record_disclosure_unavailable',
    detail: 'The current permanent-public-record disclosure is not configured consistently.',
    status: 503,
    title: 'Disclosure unavailable',
  });
}
