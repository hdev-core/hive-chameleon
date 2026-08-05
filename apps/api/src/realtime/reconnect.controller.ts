import {
  Controller,
  Get,
  Header,
  Inject,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { AccessSessionGuard } from '../auth/access-session.guard';
import { ReconnectService } from './reconnect.service';
import type { ReconnectDescriptorResponse, ReconnectHttpRequest } from './reconnect.types';

@Controller('me')
@UseGuards(AccessSessionGuard)
export class ReconnectController {
  public constructor(@Inject(ReconnectService) private readonly reconnect: ReconnectService) {}

  @Get('reconnect')
  @Header('Cache-Control', 'no-store')
  public async getDescriptor(
    @Req() request: ReconnectHttpRequest,
  ): Promise<ReconnectDescriptorResponse> {
    if (!request.authPrincipal) {
      throw new UnauthorizedException({
        code: 'playable_session_required',
        detail: 'A playable game session is required to discover a reconnect reservation.',
        status: 401,
        title: 'Unauthorized',
      });
    }
    return this.reconnect.getDescriptor(request.authPrincipal.playerId);
  }
}
