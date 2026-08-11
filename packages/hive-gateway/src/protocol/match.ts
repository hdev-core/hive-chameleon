import { z } from 'zod';

import {
  controlledCodeSchema,
  fixedScoreSchema,
  hiveAccountSchema,
  isoTimestampSchema,
  sha256Schema,
  uuidV7Schema,
} from './common.js';

const matchParticipantSchema = z.strictObject({
  account: hiveAccountSchema,
  initial_role: z.enum(['hider', 'hunter']),
  final_role: z.enum(['hider', 'hunter']),
  outcome: z.enum(['survived', 'found', 'converted', 'hunter_win', 'hunter_loss']),
  score: fixedScoreSchema,
});

const discoverySchema = z.strictObject({
  hunter: hiveAccountSchema,
  hider: hiveAccountSchema,
});

const likeAggregateSchema = z.strictObject({
  account: hiveAccountSchema,
  received: z.number().int().min(0).max(9),
});

export const matchResultSchema = z
  .strictObject({
    round_id: uuidV7Schema,
    completed_at: isoTimestampSchema,
    context: z.enum(['normal', 'tournament']),
    tournament_id: uuidV7Schema.optional(),
    mode: z.enum(['casual', 'infection']),
    result_schema: controlledCodeSchema,
    scoring_rules: controlledCodeSchema,
    map: z.strictObject({
      map_id: uuidV7Schema,
      version_id: uuidV7Schema,
      version: z.string().min(1).max(32),
      content_sha256: sha256Schema,
    }),
    server: z.strictObject({
      build: z.string().min(1).max(64),
      protocol: controlledCodeSchema,
    }),
    winning_side: z.enum(['hiders', 'hunters', 'none']),
    winner_accounts: z.array(hiveAccountSchema).max(10),
    participants: z.array(matchParticipantSchema).min(1).max(10),
    discoveries: z.array(discoverySchema).max(45),
    survivors: z.array(hiveAccountSchema).max(10),
    likes: z.array(likeAggregateSchema).max(10),
    result_sha256: sha256Schema,
  })
  .superRefine((result, context) => {
    if (result.context === 'tournament' && result.tournament_id === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Tournament results require tournament_id',
        path: ['tournament_id'],
      });
    }
    if (result.context === 'normal' && result.tournament_id !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Normal results cannot include tournament_id',
        path: ['tournament_id'],
      });
    }

    const participantAccounts = result.participants.map((participant) => participant.account);
    if (new Set(participantAccounts).size !== participantAccounts.length) {
      context.addIssue({ code: 'custom', message: 'Participant accounts must be unique' });
    }

    const participantSet = new Set(participantAccounts);
    assertUniqueAccounts(result.winner_accounts, context, ['winner_accounts'], 'Winner accounts');
    assertUniqueAccounts(result.survivors, context, ['survivors'], 'Survivor accounts');
    assertUniqueAccounts(
      result.likes.map((like) => like.account),
      context,
      ['likes'],
      'Like aggregate accounts',
    );
    for (const [index, account] of result.winner_accounts.entries()) {
      if (!participantSet.has(account)) {
        context.addIssue({
          code: 'custom',
          message: 'Winner must be a participant',
          path: ['winner_accounts', index],
        });
      }
    }
    for (const [index, account] of result.survivors.entries()) {
      if (!participantSet.has(account)) {
        context.addIssue({
          code: 'custom',
          message: 'Survivor must be a participant',
          path: ['survivors', index],
        });
      }
    }
    for (const [index, like] of result.likes.entries()) {
      if (!participantSet.has(like.account)) {
        context.addIssue({
          code: 'custom',
          message: 'Like aggregate account must be a participant',
          path: ['likes', index, 'account'],
        });
      }
    }
    for (const [index, discovery] of result.discoveries.entries()) {
      if (!participantSet.has(discovery.hunter) || !participantSet.has(discovery.hider)) {
        context.addIssue({
          code: 'custom',
          message: 'Discovery accounts must be participants',
          path: ['discoveries', index],
        });
      }
    }
    if (result.winning_side === 'none' && result.winner_accounts.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'A result without a winning side cannot list winner accounts',
        path: ['winner_accounts'],
      });
    }
  });

const matchBatchSchema = z
  .strictObject({
    v: z.literal(1),
    type: z.literal('match_results_batch'),
    event_version: z.literal(1),
    event_id: uuidV7Schema,
    occurred_at: isoTimestampSchema,
    data: z.strictObject({
      batch_id: uuidV7Schema,
      period_start: isoTimestampSchema,
      period_end: isoTimestampSchema,
      publisher: hiveAccountSchema,
      result_count: z.number().int().min(1).max(20),
      results: z.array(matchResultSchema).min(1).max(20),
    }),
  })
  .superRefine((event, context) => {
    if (event.data.result_count !== event.data.results.length) {
      context.addIssue({
        code: 'custom',
        message: 'result_count must equal results length',
        path: ['data', 'result_count'],
      });
    }

    const periodStart = Date.parse(event.data.period_start);
    const periodEnd = Date.parse(event.data.period_end);
    if (periodEnd <= periodStart) {
      context.addIssue({
        code: 'custom',
        message: 'Publication period is inverted',
        path: ['data'],
      });
    }

    for (const [index, result] of event.data.results.entries()) {
      const completedAt = Date.parse(result.completed_at);
      if (completedAt < periodStart || completedAt >= periodEnd) {
        context.addIssue({
          code: 'custom',
          message: 'Result completion must be inside the half-open publication period',
          path: ['data', 'results', index, 'completed_at'],
        });
      }
    }

    for (let index = 1; index < event.data.results.length; index += 1) {
      const previous = event.data.results[index - 1];
      const current = event.data.results[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        (Date.parse(previous.completed_at) > Date.parse(current.completed_at) ||
          (Date.parse(previous.completed_at) === Date.parse(current.completed_at) &&
            previous.round_id > current.round_id))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Results must be ordered by completed_at and round_id',
          path: ['data', 'results', index],
        });
      }
    }

    const roundIds = event.data.results.map((result) => result.round_id);
    if (new Set(roundIds).size !== roundIds.length) {
      context.addIssue({ code: 'custom', message: 'Round IDs must be unique inside a batch' });
    }
  });

const matchCorrectionSchema = z
  .strictObject({
    v: z.literal(1),
    type: z.literal('match_result_corrected'),
    event_version: z.literal(1),
    event_id: uuidV7Schema,
    occurred_at: isoTimestampSchema,
    data: z.strictObject({
      round_id: uuidV7Schema,
      original_batch_id: uuidV7Schema,
      original_event_id: uuidV7Schema,
      supersedes_event_id: uuidV7Schema,
      publisher: hiveAccountSchema,
      reason_code: controlledCodeSchema,
      replacement_result: matchResultSchema,
    }),
  })
  .superRefine((event, context) => {
    if (event.data.replacement_result.round_id !== event.data.round_id) {
      context.addIssue({
        code: 'custom',
        message: 'Correction cannot change round_id',
        path: ['data', 'replacement_result', 'round_id'],
      });
    }
  });

const matchInvalidationSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('match_result_invalidated'),
  event_version: z.literal(1),
  event_id: uuidV7Schema,
  occurred_at: isoTimestampSchema,
  data: z.strictObject({
    round_id: uuidV7Schema,
    original_batch_id: uuidV7Schema,
    original_event_id: uuidV7Schema,
    supersedes_event_id: uuidV7Schema,
    publisher: hiveAccountSchema,
    reason_code: controlledCodeSchema,
  }),
});

export const matchEventSchema = z.discriminatedUnion('type', [
  matchBatchSchema,
  matchCorrectionSchema,
  matchInvalidationSchema,
]);

export type MatchEvent = z.infer<typeof matchEventSchema>;

function assertUniqueAccounts(
  accounts: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  if (new Set(accounts).size !== accounts.length) {
    context.addIssue({ code: 'custom', message: `${label} must be unique`, path });
  }
}
