import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import type { DisclosureHttpRequest } from './auth.types';
import { DisclosurePrincipalGuard } from './disclosure-principal.guard';
import { DisclosureService } from './disclosure.service';

const acknowledgmentSchema = z.strictObject({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  disclosureVersion: z.string().min(1).max(32),
});

@Controller('disclosures/public-match')
@UseGuards(DisclosurePrincipalGuard)
export class DisclosureController {
  public constructor(@Inject(DisclosureService) private readonly disclosures: DisclosureService) {}

  @Get('current')
  @Header('Cache-Control', 'no-store')
  public async getCurrent() {
    return this.disclosures.getCurrent();
  }

  @Post('acknowledgments')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  public async acknowledge(
    @Req() request: DisclosureHttpRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    assertIdempotencyKey(idempotencyKey);
    const input = acknowledgmentSchema.safeParse(body);
    if (!input.success) {
      throw validationFailed();
    }
    const playerId = request.authPrincipal?.playerId ?? null;
    const externalIdentityId = request.onboardingPrincipal?.externalIdentityId ?? null;
    if ((playerId === null) === (externalIdentityId === null)) {
      throw new UnauthorizedException();
    }
    return this.disclosures.acknowledge({
      ...input.data,
      externalIdentityId,
      playerId,
    });
  }
}

function assertIdempotencyKey(value: string | undefined): void {
  if (!value || value.length > 128 || [...value].some(isControlCharacter)) {
    throw validationFailed();
  }
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}

function validationFailed(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'validation_failed',
    detail: 'The disclosure request does not match the API contract.',
    status: 422,
    title: 'Validation failed',
  });
}
