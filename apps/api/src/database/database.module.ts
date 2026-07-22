import { Global, Module } from '@nestjs/common';

import { DatabaseConnection } from './database.connection';

@Global()
@Module({
  exports: [DatabaseConnection],
  providers: [DatabaseConnection],
})
export class DatabaseModule {}
