import type { BridgePrincipal } from './bridge-assertion';

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

export interface RealtimeHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  realtimePrincipal?: BridgePrincipal;
}

export interface RealtimeSessionResponse {
  expiresAt: string;
  nakamaToken: string;
  socketUrl: string;
}

export const NAKAMA_AUTH_CLIENT = Symbol('NAKAMA_AUTH_CLIENT');
