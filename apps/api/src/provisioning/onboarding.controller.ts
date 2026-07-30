import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { hiveAccountSchema } from '@hive-chameleon/hive-gateway';
import { z } from 'zod';

import { OnboardingSessionGuard } from '../auth/onboarding-session.guard';
import type { OnboardingHttpRequest } from '../auth/auth.types';
import type { ProvisioningStatus } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';

const usernameSchema = z.strictObject({ hiveUsername: hiveAccountSchema });
const uuidSchema = z.string().uuid();

@Controller('onboarding')
@UseGuards(OnboardingSessionGuard)
export class OnboardingController {
  public constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Post('hive-username/check')
  @Header('Cache-Control', 'no-store')
  public async checkUsername(@Body() body: unknown) {
    return this.onboarding.checkUsername(parse(usernameSchema, body).hiveUsername);
  }

  @Put('hive-username')
  @Header('Cache-Control', 'no-store')
  public async confirmUsername(
    @Req() request: OnboardingHttpRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return publicStatus(
      await this.onboarding.confirmUsername(
        principalId(request),
        parse(usernameSchema, body).hiveUsername,
        parseIdempotencyKey(idempotencyKey),
      ),
    );
  }

  @Post('provisioning')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Header('Retry-After', '5')
  public async start(@Req() request: OnboardingHttpRequest) {
    return publicStatus(await this.onboarding.start(principalId(request)));
  }

  @Get('provisioning/:provisioningId')
  @Header('Cache-Control', 'no-store')
  public async getStatus(
    @Req() request: OnboardingHttpRequest,
    @Param('provisioningId') provisioningId: string,
  ) {
    return publicStatus(
      await this.onboarding.getStatus(principalId(request), parse(uuidSchema, provisioningId)),
    );
  }
}

function publicStatus(status: ProvisioningStatus) {
  return {
    id: status.id,
    requestedHiveUsername: status.requestedHiveUsername,
    ...(status.retryAfter === null ? {} : { retryAfter: status.retryAfter }),
    ...(status.safeFailureCode === null ? {} : { safeFailureCode: status.safeFailureCode }),
    state: status.state,
    updatedAt: status.updatedAt,
  };
}

function principalId(request: OnboardingHttpRequest): string {
  if (!request.onboardingPrincipal) {
    throw new UnauthorizedException();
  }
  return request.onboardingPrincipal.externalIdentityId;
}

function parseIdempotencyKey(value: string | undefined): string {
  if (!value || value.length > 128 || [...value].some(isControlCharacter)) {
    throw validationFailed();
  }
  return value;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationFailed();
  }
  return result.data;
}

function validationFailed(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'validation_failed',
    detail: 'The onboarding request does not match the API contract.',
    status: 422,
    title: 'Validation failed',
  });
}
