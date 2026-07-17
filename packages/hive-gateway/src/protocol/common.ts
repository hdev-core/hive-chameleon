import { z } from 'zod';

export const HIVE_CHAMELEON_APPLICATION_ID = 'hive.chameleon';
export const HIVE_CHAMELEON_MAX_PAYLOAD_BYTES = 6 * 1024;

export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Expected a lowercase UUIDv7',
  );

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256');

export const hiveAccountSchema = z
  .string()
  .min(3)
  .max(16)
  .refine((account) => {
    if (account !== account.toLowerCase()) {
      return false;
    }

    return account.split('.').every((segment) => {
      return (
        segment.length >= 3 && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(segment) && !segment.includes('--')
      );
    });
  }, 'Expected a normalized lowercase Hive account name');

export const isoTimestampSchema = z.string().datetime({ offset: true });
export const fixedScoreSchema = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/);
export const controlledCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);

export const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  }, 'Expected an HTTPS URL without embedded credentials');
