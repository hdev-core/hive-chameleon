import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';

import { bearerToken } from './access-session.guard';
import type { OnboardingHttpRequest } from './auth.types';
import { TokenService } from './token.service';

@Injectable()
export class OnboardingSessionGuard implements CanActivate {
  public constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OnboardingHttpRequest>();
    request.onboardingPrincipal = this.tokens.verifyOnboardingToken(
      bearerToken(request.headers.authorization),
      new Date(),
    );
    return true;
  }
}
