import type { BridgePrincipal } from './bridge-assertion';
import type { AuthHttpRequest } from '../auth/auth.types';

export interface NakamaSessionResult {
  expires_at?: number;
  refresh_token?: string;
  token: string;
}

export interface NakamaAuthClient {
  authenticateCustom(
    assertion: string,
    create: boolean,
    username?: string,
    variables?: Record<string, string>,
  ): Promise<NakamaSessionResult>;
}

export interface RealtimeHttpRequest extends AuthHttpRequest {
  realtimePrincipal?: BridgePrincipal;
}

export interface RealtimeSessionResponse {
  expiresAt: string;
  nakamaToken: string;
  socketUrl: string;
}

export const NAKAMA_AUTH_CLIENT = Symbol('NAKAMA_AUTH_CLIENT');
