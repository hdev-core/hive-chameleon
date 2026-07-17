import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { matchesDevelopmentBearer, REALTIME_CONFIG, type RealtimeConfig } from './realtime.config';
import type { RealtimeHttpRequest } from './realtime.types';

@Injectable()
export class DevelopmentRealtimePrincipalGuard implements CanActivate {
  // Card #25 replaces this temporary strategy with the real playable-session/disclosure guard.
  // Keeping the fixed principal behind explicit non-production configuration lets #23 exercise
  // the full bridge without creating a second identity system.
  constructor(@Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const developmentPrincipal = this.config.developmentPrincipal;
    const request = context.switchToHttp().getRequest<RealtimeHttpRequest>();
    const authorization = request.headers.authorization;

    if (
      !developmentPrincipal ||
      typeof authorization !== 'string' ||
      !matchesDevelopmentBearer(authorization, developmentPrincipal.bearerToken)
    ) {
      throw new UnauthorizedException({
        code: 'playable_session_required',
        detail: 'A playable game session is required to mint a realtime credential.',
        status: 401,
        title: 'Unauthorized',
      });
    }

    request.realtimePrincipal = {
      authSessionId: developmentPrincipal.authSessionId,
      playerId: developmentPrincipal.playerId,
    };
    return true;
  }
}
