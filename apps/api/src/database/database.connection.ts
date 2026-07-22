import { createDatabasePool, type DatabasePool } from '@hive-chameleon/database';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class DatabaseConnection implements OnApplicationShutdown {
  public readonly pool: DatabasePool | null;

  public constructor() {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production.');
      }
      this.pool = null;
      return;
    }
    this.pool = createDatabasePool({ connectionString });
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}
