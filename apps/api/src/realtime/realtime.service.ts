import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { createBridgeAssertion, type BridgePrincipal } from './bridge-assertion';
import { REALTIME_CONFIG, type NakamaBridgeConfig, type RealtimeConfig } from './realtime.config';
import {
  NAKAMA_AUTH_CLIENT,
  type NakamaAuthClient,
  type RealtimeSessionResponse,
} from './realtime.types';

@Injectable()
export class RealtimeService {
  constructor(
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    @Inject(NAKAMA_AUTH_CLIENT) private readonly nakamaClient: NakamaAuthClient | null,
  ) {}

  async createSession(principal: BridgePrincipal): Promise<RealtimeSessionResponse> {
    const nakama = this.requireNakamaConfiguration();
    const assertion = createBridgeAssertion(principal, nakama);

    let session;
    try {
      session = await this.nakamaClient!.authenticateCustom(assertion, true);
    } catch {
      throw realtimeUnavailable('Nakama did not accept the scoped session request.');
    }

    if (
      !session.token ||
      !Number.isSafeInteger(session.expires_at) ||
      session.expires_at! * 1_000 <= Date.now()
    ) {
      throw realtimeUnavailable('Nakama returned an invalid scoped session.');
    }

    return {
      expiresAt: new Date(session.expires_at! * 1_000).toISOString(),
      nakamaToken: session.token,
      socketUrl: nakama.socketUrl,
    };
  }

  private requireNakamaConfiguration(): NakamaBridgeConfig {
    if (!this.config.nakama || !this.nakamaClient) {
      throw realtimeUnavailable('Realtime session minting is not configured.');
    }
    return this.config.nakama;
  }
}

function realtimeUnavailable(detail: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'realtime_unavailable',
    detail,
    status: 503,
    title: 'Realtime service unavailable',
  });
}
