import { createUuidV7, type DatabasePool, withTransaction } from '@hive-chameleon/database';
import { ServiceUnavailableException } from '@nestjs/common';

import type {
  ActiveSessionRecord,
  AuthRepository,
  ExternalIdentityRecord,
  HiveLoginChallengeRecord,
  NewSession,
  PlayerIdentity,
} from './auth.types';

interface PlayerRow {
  hive_control_state: PlayerIdentity['hiveControlState'];
  hive_username: string;
  id: string;
  is_guest: boolean;
}

interface ChallengeRow {
  challenge_text: string;
  expires_at: Date;
  hive_username: string;
  id: string;
  platform: HiveLoginChallengeRecord['platform'];
}

interface SessionRow extends PlayerRow {
  expires_at: Date;
  session_id: string;
}

interface ExternalIdentityRow {
  external_identity_id: string;
  hive_control_state: PlayerIdentity['hiveControlState'] | null;
  hive_username: string | null;
  id: string | null;
  is_guest: boolean | null;
  player_id: string | null;
  status: ExternalIdentityRecord['status'];
}

export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly pool: DatabasePool | null) {}

  public async createHiveChallenge(
    record: HiveLoginChallengeRecord & {
      readonly challengeSha256: string;
      readonly deviceSessionId: string;
      readonly issuedAt: Date;
    },
  ): Promise<void> {
    await this.requirePool().query(
      `INSERT INTO identity.hive_login_challenge (
         id, hive_username, platform, device_session_id, challenge_text,
         challenge_sha256, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.hiveUsername,
        record.platform,
        record.deviceSessionId,
        record.challenge,
        record.challengeSha256,
        record.issuedAt,
        record.expiresAt,
      ],
    );
  }

  public async consumeHiveChallenge(
    challengeId: string,
    hiveUsername: string,
    consumedAt: Date,
  ): Promise<HiveLoginChallengeRecord | null> {
    const result = await this.requirePool().query<ChallengeRow>(
      `UPDATE identity.hive_login_challenge
          SET consumed_at = $3
        WHERE id = $1
          AND hive_username = $2
          AND consumed_at IS NULL
          AND expires_at > $3
      RETURNING id, hive_username, platform, challenge_text, expires_at`,
      [challengeId, hiveUsername, consumedAt],
    );
    const row = result.rows[0];
    return row ? mapChallenge(row) : null;
  }

  public async findOrCreateDirectHivePlayer(hiveUsername: string): Promise<PlayerIdentity> {
    const result = await this.requirePool().query<PlayerRow>(
      `INSERT INTO identity.player (id, hive_username, hive_control_state)
       VALUES ($1, $2, 'external_self_custodial')
       ON CONFLICT (hive_username) DO UPDATE
         SET hive_username = EXCLUDED.hive_username
       RETURNING id, hive_username, hive_control_state, is_guest`,
      [createUuidV7(), hiveUsername],
    );
    return mapPlayer(requireRow(result.rows[0]));
  }

  public async createGuestPlayer(): Promise<PlayerIdentity> {
    const id = createUuidV7();
    const guestName = `guest-${id.replaceAll('-', '').slice(-10)}`;
    const result = await this.requirePool().query<PlayerRow>(
      `INSERT INTO identity.player (
         id, hive_username, hive_control_state, is_guest
       ) VALUES ($1, $2, 'authority_claimed_recovery_pending', true)
       RETURNING id, hive_username, hive_control_state, is_guest`,
      [id, guestName],
    );
    return mapPlayer(requireRow(result.rows[0]));
  }

  public async createSession(session: NewSession): Promise<void> {
    await withTransaction(this.requirePool(), async (client) => {
      await client.query(
        `UPDATE identity.auth_session
            SET revoked_at = $2,
                revocation_reason = 'superseded_login'
          WHERE player_id = $1 AND revoked_at IS NULL`,
        [session.player.id, session.issuedAt],
      );
      await client.query(
        `INSERT INTO identity.auth_session (
           id, player_id, external_identity_id, refresh_token_hash, platform,
           authentication_method, hive_signing_provider, hive_control_state_at_issue,
           custodial_signing_eligible, issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          session.id,
          session.player.id,
          session.externalIdentityId,
          session.refreshTokenHash,
          session.platform,
          session.authenticationMethod,
          session.hiveSigningProvider,
          session.player.hiveControlState,
          session.custodialSigningEligible,
          session.issuedAt,
          session.expiresAt,
        ],
      );
    });
  }

  public async rotateSession(
    currentRefreshTokenHash: string,
    nextRefreshTokenHash: string,
    usedAt: Date,
  ): Promise<ActiveSessionRecord | null> {
    return withTransaction(this.requirePool(), async (client) => {
      const result = await client.query<SessionRow>(
        `SELECT s.id AS session_id, s.expires_at, p.id, p.hive_username,
                p.hive_control_state, p.is_guest
           FROM identity.auth_session s
           JOIN identity.player p ON p.id = s.player_id
          WHERE s.refresh_token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > $2
          FOR UPDATE OF s`,
        [currentRefreshTokenHash, usedAt],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      await client.query(
        `UPDATE identity.auth_session
            SET refresh_token_hash = $2, last_used_at = $3
          WHERE id = $1`,
        [row.session_id, nextRefreshTokenHash, usedAt],
      );
      return mapSession(row);
    });
  }

  public async findActiveSession(sessionId: string, at: Date): Promise<ActiveSessionRecord | null> {
    const result = await this.requirePool().query<SessionRow>(
      `SELECT s.id AS session_id, s.expires_at, p.id, p.hive_username,
              p.hive_control_state, p.is_guest
         FROM identity.auth_session s
         JOIN identity.player p ON p.id = s.player_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [sessionId, at],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  public async revokeSession(sessionId: string, revokedAt: Date, reason: string): Promise<boolean> {
    const result = await this.requirePool().query(
      `UPDATE identity.auth_session
          SET revoked_at = $2, revocation_reason = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, revokedAt, reason],
    );
    return result.rowCount === 1;
  }

  public async upsertGoogleIdentity(
    verifiedIssuer: string,
    subjectLookupHash: string,
    authenticatedAt: Date,
  ): Promise<ExternalIdentityRecord> {
    const result = await this.requirePool().query<ExternalIdentityRow>(
      `WITH upserted AS (
         INSERT INTO identity.external_identity (
           id, provider, verified_issuer, subject_lookup_hash, status,
           verified_at, last_authenticated_at
         ) VALUES ($1, 'google', $2, $3, 'provisioning', $4, $4)
         ON CONFLICT (provider, verified_issuer, subject_lookup_hash) DO UPDATE
           SET last_authenticated_at = EXCLUDED.last_authenticated_at,
               updated_at = EXCLUDED.last_authenticated_at
         RETURNING id, player_id, status
       )
       SELECT e.id AS external_identity_id, e.player_id, e.status,
              p.id, p.hive_username, p.hive_control_state, p.is_guest
         FROM upserted e
         LEFT JOIN identity.player p ON p.id = e.player_id`,
      [createUuidV7(), verifiedIssuer, subjectLookupHash, authenticatedAt],
    );
    const row = requireRow(result.rows[0]);
    return {
      id: row.external_identity_id,
      player:
        row.player_id === null
          ? null
          : mapPlayer({
              hive_control_state: requireValue(row.hive_control_state),
              hive_username: requireValue(row.hive_username),
              id: requireValue(row.id),
              is_guest: requireValue(row.is_guest),
            }),
      status: row.status,
    };
  }

  private requirePool(): DatabasePool {
    if (!this.pool) {
      throw new ServiceUnavailableException({
        code: 'identity_store_unavailable',
        detail: 'Authentication is unavailable because the identity store is not configured.',
        status: 503,
        title: 'Authentication unavailable',
      });
    }
    return this.pool;
  }
}

function mapChallenge(row: ChallengeRow): HiveLoginChallengeRecord {
  return {
    challenge: row.challenge_text,
    expiresAt: row.expires_at,
    hiveUsername: row.hive_username,
    id: row.id,
    platform: row.platform,
  };
}

function mapPlayer(row: PlayerRow): PlayerIdentity {
  return {
    hiveControlState: row.hive_control_state,
    hiveUsername: row.hive_username,
    id: row.id,
    isGuest: row.is_guest,
  };
}

function mapSession(row: SessionRow): ActiveSessionRecord {
  const player = mapPlayer(row);
  return {
    authSessionId: row.session_id,
    expiresAt: row.expires_at,
    player,
    playerId: player.id,
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error('The identity store did not return the expected row.');
  }
  return row;
}

function requireValue<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Linked external identity is missing its player row.');
  }
  return value;
}
