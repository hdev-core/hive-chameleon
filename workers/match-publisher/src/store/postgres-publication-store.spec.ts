import { describe, expect, it } from 'vitest';

import { serializeHiveChameleonEvent, sha256Hex } from '@hive-chameleon/hive-gateway';
import { MATCH_EVENT_FIXTURE } from '@hive-chameleon/hive-gateway/testing';

import { PostgresMatchPublicationStore } from './postgres-publication-store.js';
import type { SqlClientPort, SqlPoolPort, SqlQueryResult } from './postgres-publication-store.js';

describe('PostgresMatchPublicationStore', () => {
  it('freezes one canonical outbox and ordered membership in the claim transaction', async () => {
    const client = new FixtureSqlClient((text) => {
      if (text.includes('WITH selected_requests AS')) {
        return { rows: [candidateRow()], rowCount: 1 };
      }
      if (text.includes('UPDATE game.match_publication_request')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    });
    const ids = [
      '01910000-0000-7000-8000-000000000001',
      '01910000-0000-7000-8000-000000000002',
      '01910000-0000-7000-8000-000000000003',
      '01910000-0000-7000-8000-000000000004',
    ];
    let idIndex = 0;
    const store = new PostgresMatchPublicationStore(new FixtureSqlPool(client));

    const frozen = await store.freezeNextBatch(new Date('2026-07-23T12:10:00.000Z'), {
      publisherAccount: 'match-pub',
      maximumAgeMs: 5 * 60 * 1_000,
      maximumResults: 20,
      maximumPayloadBytes: 6 * 1024,
      nextUuidV7: () => ids[idIndex++] ?? 'missing',
    });

    expect(frozen?.eventId).toBe(ids[0]);
    expect(frozen?.batchId).toBe(ids[1]);
    expect(frozen?.outboxId).toBe(ids[2]);
    expect(client.statements[0]?.text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(client.statements.at(-1)?.text).toBe('COMMIT');
    const outboxInsert = client.statements.find((statement) =>
      statement.text.includes('INSERT INTO game.match_publication_outbox'),
    );
    expect(outboxInsert?.values?.[7]).toBe(frozen?.canonicalPayload);
    expect(outboxInsert?.values?.[8]).toBe(frozen?.payloadSha256);
    expect(
      client.statements.some((statement) => statement.text.includes('match_publication_item')),
    ).toBe(true);
  });

  it('reuses the exact frozen payload and identifiers when claiming a retry', async () => {
    if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
      throw new Error('fixture is not a match batch');
    }
    const canonicalPayload = serializeHiveChameleonEvent(MATCH_EVENT_FIXTURE);
    const eventId = MATCH_EVENT_FIXTURE.event_id;
    const batchId = MATCH_EVENT_FIXTURE.data.batch_id;
    const client = new FixtureSqlClient((text) => {
      if (text.includes('WITH candidate AS')) {
        return {
          rows: [
            {
              id: '01910000-0000-7000-8000-000000000020',
              event_uuid: eventId,
              batch_uuid: batchId,
              attempt_count: 3,
              canonical_payload: canonicalPayload,
              payload_sha256: sha256Hex(canonicalPayload),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    });
    const store = new PostgresMatchPublicationStore(new FixtureSqlPool(client));

    const attempt = await store.claimNextOutbox(
      new Date('2026-07-23T12:00:00.000Z'),
      new Date('2026-07-23T12:01:00.000Z'),
    );

    expect(attempt).toMatchObject({
      eventId,
      batchId,
      attemptCount: 3,
      canonicalPayload,
    });
    expect(attempt?.event).toEqual(MATCH_EVENT_FIXTURE);
  });
});

interface FixtureStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class FixtureSqlPool implements SqlPoolPort {
  public constructor(private readonly client: FixtureSqlClient) {}

  public async connect(): Promise<SqlClientPort> {
    return this.client;
  }
}

class FixtureSqlClient implements SqlClientPort {
  public readonly statements: FixtureStatement[] = [];

  public constructor(
    private readonly respond: (
      text: string,
      values?: readonly unknown[],
    ) => SqlQueryResult<Record<string, unknown>>,
  ) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push({ text, ...(values === undefined ? {} : { values }) });
    return this.respond(text, values) as SqlQueryResult<Row>;
  }

  public release(): void {}
}

function candidateRow(): Record<string, unknown> {
  if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
    throw new Error('fixture is not a match batch');
  }
  const result = MATCH_EVENT_FIXTURE.data.results[0];
  if (result === undefined) {
    throw new Error('fixture result is missing');
  }
  return {
    publication_request_id: '01910000-0000-7000-8000-000000000010',
    result_revision_id: '01910000-0000-7000-8000-000000000011',
    round_id: result.round_id,
    completed_at: result.completed_at,
    requested_at: result.completed_at,
    tournament_id: null,
    mode: result.mode,
    result_schema_version: result.result_schema,
    scoring_rule_version: result.scoring_rules,
    map_id: result.map.map_id,
    map_version_id: result.map.version_id,
    map_version: result.map.version,
    map_content_sha256: result.map.content_sha256,
    game_server_build_version: result.server.build,
    protocol_version: result.server.protocol,
    winning_side: result.winning_side,
    winner_accounts: result.winner_accounts,
    participants: result.participants,
    discoveries: result.discoveries,
    survivors: result.survivors,
    likes: result.likes,
    result_sha256: result.result_sha256,
  };
}
