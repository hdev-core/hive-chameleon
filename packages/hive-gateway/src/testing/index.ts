if (process.env.NODE_ENV === 'production') {
  throw new Error('Hive Gateway testing exports are disabled in production');
}

export * from './fakes.js';
export * from './fixtures.js';
