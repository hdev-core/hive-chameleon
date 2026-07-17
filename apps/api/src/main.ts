import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadHttpConfig } from './http.config';

async function bootstrap(): Promise<void> {
  const httpConfig = loadHttpConfig();
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  if (httpConfig.corsAllowedOrigins.length > 0) {
    app.enableCors({
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      credentials: false,
      maxAge: 600,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      origin: [...httpConfig.corsAllowedOrigins],
    });
  }

  await app.listen(httpConfig.port, '0.0.0.0');
}

void bootstrap();
