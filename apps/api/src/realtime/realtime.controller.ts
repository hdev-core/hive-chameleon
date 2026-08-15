import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { AccessSessionGuard } from '../auth/access-session.guard';
import { RealtimeService } from './realtime.service';
import type { RealtimeHttpRequest, RealtimeSessionResponse } from './realtime.types';

@Controller('realtime')
@UseGuards(AccessSessionGuard)
export class RealtimeController {
  constructor(@Inject(RealtimeService) private readonly realtimeService: RealtimeService) {}

  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async createSession(@Req() request: RealtimeHttpRequest): Promise<RealtimeSessionResponse> {
    if (!request.authPrincipal) {
      throw new UnauthorizedException({
        code: 'playable_session_required',
        detail: 'A playable game session is required to mint a realtime credential.',
        status: 401,
        title: 'Unauthorized',
      });
    }
    return this.realtimeService.createSession({
      authSessionId: request.authPrincipal.authSessionId,
      playerId: request.authPrincipal.playerId,
    });
  }
}
