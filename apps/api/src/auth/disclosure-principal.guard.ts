import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { bearerToken } from './access-session.guard';
import { AUTH_REPOSITORY, type AuthRepository, type DisclosureHttpRequest } from './auth.types';
import { TokenService } from './token.service';

@Injectable()
export class DisclosurePrincipalGuard implements CanActivate {
  public constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DisclosureHttpRequest>();
    const token = bearerToken(request.headers.authorization);
    const now = new Date();
    try {
      const claims = this.tokens.verifyAccessToken(token, now);
      const session = await this.repository.findActiveSession(claims.sessionId, now);
      if (!session || session.playerId !== claims.playerId) {
        throw invalidPrincipal();
      }
      request.authPrincipal = session;
      return true;
    } catch (error: unknown) {
      if (!(error instanceof UnauthorizedException)) {
        throw error;
      }
    }

    request.onboardingPrincipal = this.tokens.verifyOnboardingToken(token, now);
    return true;
  }
}

function invalidPrincipal(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_session',
    detail: 'The disclosure principal is invalid, expired, or revoked.',
    status: 401,
    title: 'Unauthorized',
  });
}
