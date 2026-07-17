import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@hive-chameleon\/hive-gateway\/protocol$/,
        replacement: fileURLToPath(
          new URL('../../packages/hive-gateway/src/protocol/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@hive-chameleon\/hive-gateway\/testing$/,
        replacement: fileURLToPath(
          new URL('../../packages/hive-gateway/src/testing/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@hive-chameleon\/hive-gateway$/,
        replacement: fileURLToPath(
          new URL('../../packages/hive-gateway/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
