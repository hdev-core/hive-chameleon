import { z } from 'zod';

import {
  controlledCodeSchema,
  hiveAccountSchema,
  httpsUrlSchema,
  isoTimestampSchema,
  sha256Schema,
  uuidV7Schema,
} from './common.js';

const collectibleIssuedSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('collectible_issued'),
  event_id: uuidV7Schema,
  occurred_at: isoTimestampSchema,
  data: z.strictObject({
    collectible_id: uuidV7Schema,
    definition_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/),
    kind: z.enum([
      'badge',
      'weapon_skin',
      'character_material',
      'lobby_emote',
      'profile_frame',
      'victory_effect',
    ]),
    owner: hiveAccountSchema,
    issuer: hiveAccountSchema,
    reason: controlledCodeSchema,
    metadata_uri: httpsUrlSchema,
    metadata_sha256: sha256Schema,
    payment_tx_id: z.string().min(1).max(128).optional(),
  }),
});

const collectibleRevokedSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('collectible_revoked'),
  event_id: uuidV7Schema,
  occurred_at: isoTimestampSchema,
  data: z.strictObject({
    collectible_id: uuidV7Schema,
    issued_event_id: uuidV7Schema,
    reason_code: controlledCodeSchema,
  }),
});

export const collectibleEventSchema = z.discriminatedUnion('type', [
  collectibleIssuedSchema,
  collectibleRevokedSchema,
]);

export type CollectibleEvent = z.infer<typeof collectibleEventSchema>;
