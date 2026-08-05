import { Module } from '@nestjs/common';
import { Client } from '@heroiclabs/nakama-js';

import { AuthModule } from '../auth/auth.module';
import { DatabaseConnection } from '../database/database.connection';
import { PostgresReconnectRepository } from './postgres-reconnect.repository';
import { ReconnectController } from './reconnect.controller';
import { ReconnectService } from './reconnect.service';
import { RECONNECT_REPOSITORY } from './reconnect.types';
import { RealtimeController } from './realtime.controller';
import { loadRealtimeConfig, REALTIME_CONFIG, type RealtimeConfig } from './realtime.config';
import { RealtimeService } from './realtime.service';
import { NAKAMA_AUTH_CLIENT, type NakamaAuthClient } from './realtime.types';

@Module({
  imports: [AuthModule],
  controllers: [RealtimeController, ReconnectController],
  providers: [
    {
      provide: REALTIME_CONFIG,
      useFactory: loadRealtimeConfig,
    },
    {
      provide: NAKAMA_AUTH_CLIENT,
      inject: [REALTIME_CONFIG],
      useFactory: (config: RealtimeConfig): NakamaAuthClient | null => {
        if (!config.nakama) {
          return null;
        }

        const url = new URL(config.nakama.httpUrl);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        return new Client(
          config.nakama.serverKey,
          url.hostname,
          port,
          url.protocol === 'https:',
          config.nakama.requestTimeoutMs,
          false,
        );
      },
    },
    {
      provide: RECONNECT_REPOSITORY,
      inject: [DatabaseConnection],
      useFactory: (database: DatabaseConnection) => new PostgresReconnectRepository(database.pool),
    },
    ReconnectService,
    RealtimeService,
  ],
  exports: [RealtimeService],
})
export class RealtimeModule {}
