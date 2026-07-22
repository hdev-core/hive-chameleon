import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AUTH_REPOSITORY, type AuthHttpRequest, type AuthRepository } from './auth.types';
import { TokenService } from './token.service';

@Injectable()
export class AccessSessionGuard implements CanActivate {
  public constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthHttpRequest>();
    const token = bearerToken(request.headers.authorization);
    const claims = this.tokens.verifyAccessToken(token, new Date());
    const session = await this.repository.findActiveSession(claims.sessionId, new Date());
    if (!session || session.playerId !== claims.playerId) {
      throw invalidSession();
    }
    request.authPrincipal = session;
    return true;
  }
}

export function bearerToken(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw invalidSession();
  }
  const token = header.slice('Bearer '.length);
  if (!token || token.includes(' ')) {
    throw invalidSession();
  }
  return token;
}

function invalidSession(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_session',
    detail: 'The session credential is missing, invalid, expired, or revoked.',
    status: 401,
    title: 'Unauthorized',
  });
}
