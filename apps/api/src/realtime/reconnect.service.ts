import { Inject, Injectable } from '@nestjs/common';

import {
  RECONNECT_REPOSITORY,
  type ReconnectDescriptorResponse,
  type ReconnectRepository,
} from './reconnect.types';

@Injectable()
export class ReconnectService {
  public constructor(
    @Inject(RECONNECT_REPOSITORY) private readonly repository: ReconnectRepository,
  ) {}

  public async getDescriptor(
    playerId: string,
    checkedAt = new Date(),
  ): Promise<ReconnectDescriptorResponse> {
    const reservation = await this.repository.findAvailable(playerId, checkedAt);
    if (!reservation || reservation.expiresAt <= checkedAt) {
      return { available: false };
    }
    return {
      available: true,
      expiresAt: reservation.expiresAt.toISOString(),
      lobbyId: reservation.lobbyId,
      restorationMode: reservation.restorationMode,
    };
  }
}
