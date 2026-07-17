import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DevelopmentRealtimePrincipalGuard } from './development-realtime-principal.guard';
import type { RealtimeConfig } from './realtime.config';
import type { RealtimeHttpRequest } from './realtime.types';

describe('DevelopmentRealtimePrincipalGuard', () => {
  it('binds only the fixed configured principal', () => {
    const request = requestWithAuthorization('Bearer 0123456789abcdef0123456789abcdef');
    const guard = new DevelopmentRealtimePrincipalGuard(config());

    expect(guard.canActivate(executionContext(request))).toBe(true);
    expect(request.realtimePrincipal).toEqual({
      authSessionId: '01980abc-def1-7abc-9def-0123456789ab',
      playerId: '01980abc-def0-7abc-8def-0123456789ab',
    });
  });

  it('denies missing or incorrect credentials without accepting caller identity', () => {
    const guard = new DevelopmentRealtimePrincipalGuard(config());
    const request = requestWithAuthorization('Bearer wrong');

    expect(() => guard.canActivate(executionContext(request))).toThrow(UnauthorizedException);
    expect(request.realtimePrincipal).toBeUndefined();
  });
});

function config(): RealtimeConfig {
  return {
    developmentPrincipal: {
      authSessionId: '01980abc-def1-7abc-9def-0123456789ab',
      bearerToken: '0123456789abcdef0123456789abcdef',
      playerId: '01980abc-def0-7abc-8def-0123456789ab',
    },
    nakama: null,
    nodeEnvironment: 'test',
  };
}

function requestWithAuthorization(authorization: string): RealtimeHttpRequest {
  return { headers: { authorization } };
}

function executionContext(request: RealtimeHttpRequest): ExecutionContext {
  return {
    getArgByIndex: () => undefined,
    getArgs: () => [],
    getClass: () => DevelopmentRealtimePrincipalGuard,
    getHandler: () => DevelopmentRealtimePrincipalGuard.prototype.canActivate,
    getType: () => 'http',
    switchToHttp: () => ({
      getNext: () => undefined,
      getRequest: () => request,
      getResponse: () => undefined,
    }),
    switchToRpc: () => ({
      getContext: () => undefined,
      getData: () => undefined,
    }),
    switchToWs: () => ({
      getClient: () => undefined,
      getData: () => undefined,
      getPattern: () => undefined,
    }),
  } as unknown as ExecutionContext;
}
