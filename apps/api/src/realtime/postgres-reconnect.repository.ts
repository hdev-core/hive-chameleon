import type { DatabasePool } from '@hive-chameleon/database';
import { ServiceUnavailableException } from '@nestjs/common';

import type {
  ReconnectRepository,
  ReconnectReservationRecord,
  ReconnectRestorationMode,
} from './reconnect.types';

interface ReconnectReservationRow {
  expires_at: Date;
  lobby_id: string;
  restoration_mode: ReconnectRestorationMode;
}

export class PostgresReconnectRepository implements ReconnectRepository {
  public constructor(private readonly pool: DatabasePool | null) {}

  public async findAvailable(
    playerId: string,
    checkedAt: Date,
  ): Promise<ReconnectReservationRecord | null> {
    const result = await this.requirePool().query<ReconnectReservationRow>(
      `SELECT lobby_id, expires_at, restoration_mode
         FROM game.hc_find_reconnect_reservation($1, $2)`,
      [playerId, checkedAt],
    );
    const row = result.rows[0];
    return row
      ? {
          expiresAt: row.expires_at,
          lobbyId: row.lobby_id,
          restorationMode: row.restoration_mode,
        }
      : null;
  }

  private requirePool(): DatabasePool {
    if (!this.pool) {
      throw new ServiceUnavailableException({
        code: 'reconnect_store_unavailable',
        detail: 'Reconnect discovery is unavailable because the game store is not configured.',
        status: 503,
        title: 'Reconnect discovery unavailable',
      });
    }
    return this.pool;
  }
}
