import type { AuthHttpRequest } from '../auth/auth.types';

export type ReconnectRestorationMode = 'same_role' | 'spectate' | 'next_round';

export interface ReconnectReservationRecord {
  readonly expiresAt: Date;
  readonly lobbyId: string;
  readonly restorationMode: ReconnectRestorationMode;
}

export interface ReconnectDescriptorResponse {
  readonly available: boolean;
  readonly expiresAt?: string;
  readonly lobbyId?: string;
  readonly restorationMode?: ReconnectRestorationMode;
}

export interface ReconnectRepository {
  findAvailable(playerId: string, checkedAt: Date): Promise<ReconnectReservationRecord | null>;
}

export type ReconnectHttpRequest = AuthHttpRequest;

export const RECONNECT_REPOSITORY = Symbol('RECONNECT_REPOSITORY');
