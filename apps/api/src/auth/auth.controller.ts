import {
  Body,
  Controller,
  Delete,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { hiveAccountSchema } from '@hive-chameleon/hive-gateway';
import { z } from 'zod';

import { AccessSessionGuard } from './access-session.guard';
import { AuthService } from './auth.service';
import type { AuthHttpRequest } from './auth.types';

const clientPlatformSchema = z.enum(['webgl', 'windows', 'macos', 'linux']);
const hiveChallengeSchema = z.strictObject({
  hiveUsername: hiveAccountSchema,
  platform: clientPlatformSchema,
});
const hiveSessionSchema = z.strictObject({
  challengeId: z.string().uuid(),
  hiveUsername: hiveAccountSchema,
  signature: z.string().regex(/^[0-9a-f]{130}$/),
  signingProvider: z.enum(['keychain', 'hiveauth', 'hivesigner']),
});
const googleExchangeSchema = z.strictObject({
  authorizationCode: z.string().min(1).max(4_096),
  codeVerifier: z.string().min(43).max(128),
  platform: clientPlatformSchema,
  redirectUri: z.string().url().max(2_048),
});
const refreshSchema = z.strictObject({ refreshToken: z.string().min(32).max(2_048) });

@Controller('auth')
export class AuthController {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('hive/challenges')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  public async createHiveChallenge(@Body() body: unknown) {
    const input = parse(hiveChallengeSchema, body);
    return this.auth.createHiveChallenge(input.hiveUsername, input.platform);
  }

  @Post('hive/sessions')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  public async createHiveSession(@Body() body: unknown) {
    return this.auth.createHiveSession(parse(hiveSessionSchema, body));
  }

  @Post('google/exchange')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  public async exchangeGoogle(@Body() body: unknown) {
    return this.auth.exchangeGoogle(parse(googleExchangeSchema, body));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  public async refresh(@Body() body: unknown) {
    return this.auth.refresh(parse(refreshSchema, body).refreshToken);
  }

  @Delete('session')
  @UseGuards(AccessSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  public async revokeSession(@Req() request: AuthHttpRequest): Promise<void> {
    if (request.authPrincipal) {
      await this.auth.revokeSession(request.authPrincipal.authSessionId);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new UnprocessableEntityException({
      code: 'validation_failed',
      detail: 'The request body does not match the authentication contract.',
      errors: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join('.'),
      })),
      status: 422,
      title: 'Validation failed',
    });
  }
  return result.data;
}
