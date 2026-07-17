if (process.env.NODE_ENV === 'production') {
  throw new Error('HAF projector testing exports are disabled in production');
}

export * from './fixture-source.js';
export * from './in-memory-store.js';
