import { createHash, timingSafeEqual } from 'node:crypto';

export const REALTIME_CONFIG = Symbol('REALTIME_CONFIG');

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DevelopmentRealtimePrincipalConfig {
  authSessionId: string;
  bearerToken: string;
  playerId: string;
}

export interface NakamaBridgeConfig {
  assertionTtlSeconds: number;
  bridgeHmacKey: Buffer;
  httpUrl: string;
  requestTimeoutMs: number;
  serverKey: string;
  socketUrl: string;
}

export interface RealtimeConfig {
  developmentPrincipal: DevelopmentRealtimePrincipalConfig | null;
  nakama: NakamaBridgeConfig | null;
  nodeEnvironment: string;
}

export function loadRealtimeConfig(environment: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const nodeEnvironment = environment.NODE_ENV?.trim() || 'development';
  const nakama = loadNakamaBridgeConfig(environment, nodeEnvironment);
  const developmentPrincipal = loadDevelopmentPrincipal(environment, nodeEnvironment, nakama);

  return { developmentPrincipal, nakama, nodeEnvironment };
}

export function isCanonicalUuidV7(value: string): boolean {
  return uuidV7Pattern.test(value);
}

export function matchesDevelopmentBearer(header: string | undefined, expected: string): boolean {
  const prefix = 'Bearer ';
  const candidate = header?.startsWith(prefix) ? header.slice(prefix.length) : '';
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();

  return candidate.length > 0 && timingSafeEqual(candidateHash, expectedHash);
}

function loadNakamaBridgeConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnvironment: string,
): NakamaBridgeConfig | null {
  const raw = {
    bridgeHmacKey: environment.NAKAMA_BRIDGE_HMAC_KEY?.trim(),
    httpUrl: environment.NAKAMA_HTTP_URL?.trim(),
    serverKey: environment.NAKAMA_SERVER_KEY?.trim(),
    socketUrl: environment.NAKAMA_SOCKET_URL?.trim(),
  };
  const values = Object.values(raw);

  if (values.every((value) => !value)) {
    return null;
  }
  if (values.some((value) => !value)) {
    throw new Error(
      'NAKAMA_HTTP_URL, NAKAMA_SOCKET_URL, NAKAMA_SERVER_KEY, and NAKAMA_BRIDGE_HMAC_KEY must be configured together.',
    );
  }

  const httpUrl = parseServiceUrl(raw.httpUrl!, ['http:', 'https:'], 'NAKAMA_HTTP_URL');
  const socketUrl = parseServiceUrl(raw.socketUrl!, ['ws:', 'wss:'], 'NAKAMA_SOCKET_URL', true);
  if (nodeEnvironment === 'production') {
    if (httpUrl.protocol !== 'https:' || socketUrl.protocol !== 'wss:') {
      throw new Error('Production Nakama HTTP and socket URLs must use TLS.');
    }
  }

  const bridgeHmacKey = decodeBridgeKey(raw.bridgeHmacKey!);
  const assertionTtlSeconds = parseBoundedInteger(
    environment.NAKAMA_BRIDGE_ASSERTION_TTL_SECONDS,
    30,
    5,
    60,
    'NAKAMA_BRIDGE_ASSERTION_TTL_SECONDS',
  );
  const requestTimeoutMs = parseBoundedInteger(
    environment.NAKAMA_REQUEST_TIMEOUT_MS,
    5_000,
    100,
    30_000,
    'NAKAMA_REQUEST_TIMEOUT_MS',
  );

  return {
    assertionTtlSeconds,
    bridgeHmacKey,
    httpUrl: httpUrl.toString(),
    requestTimeoutMs,
    serverKey: raw.serverKey!,
    socketUrl: socketUrl.toString(),
  };
}

function loadDevelopmentPrincipal(
  environment: NodeJS.ProcessEnv,
  nodeEnvironment: string,
  nakama: NakamaBridgeConfig | null,
): DevelopmentRealtimePrincipalConfig | null {
  const enabledValue = environment.REALTIME_DEV_PRINCIPAL_ENABLED?.trim().toLowerCase();
  if (!enabledValue || enabledValue === 'false') {
    return null;
  }
  if (enabledValue !== 'true') {
    throw new Error('REALTIME_DEV_PRINCIPAL_ENABLED must be true or false.');
  }
  if (nodeEnvironment === 'production') {
    throw new Error('The development realtime principal cannot be enabled in production.');
  }
  if (!nakama) {
    throw new Error('The development realtime principal requires Nakama bridge configuration.');
  }
  if (environment.REALTIME_DEV_DISCLOSURE_ACKNOWLEDGED?.trim().toLowerCase() !== 'true') {
    throw new Error(
      'REALTIME_DEV_DISCLOSURE_ACKNOWLEDGED=true is required for the development realtime principal.',
    );
  }

  const playerId = environment.REALTIME_DEV_PLAYER_ID?.trim() ?? '';
  const authSessionId = environment.REALTIME_DEV_AUTH_SESSION_ID?.trim() ?? '';
  const bearerToken = environment.REALTIME_DEV_BEARER_TOKEN ?? '';
  if (!isCanonicalUuidV7(playerId) || !isCanonicalUuidV7(authSessionId)) {
    throw new Error('Development player and auth-session IDs must be canonical UUIDv7 values.');
  }
  if (bearerToken.length < 32) {
    throw new Error('REALTIME_DEV_BEARER_TOKEN must contain at least 32 characters.');
  }

  return { authSessionId, bearerToken, playerId };
}

function decodeBridgeKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('NAKAMA_BRIDGE_HMAC_KEY must be canonical unpadded base64url.');
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length < 32 || decoded.toString('base64url') !== encoded) {
    throw new Error(
      'NAKAMA_BRIDGE_HMAC_KEY must be canonical unpadded base64url encoding at least 32 bytes.',
    );
  }
  return decoded;
}

function parseServiceUrl(
  value: string,
  protocols: string[],
  name: string,
  allowWebSocketPath = false,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} uses an unsupported protocol.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} cannot contain credentials, a query, or a fragment.`);
  }
  if (allowWebSocketPath) {
    if (parsed.pathname !== '/' && parsed.pathname !== '/ws') {
      throw new Error(`${name} path must be / or /ws.`);
    }
  } else if (parsed.pathname !== '/') {
    throw new Error(`${name} cannot contain a path.`);
  }

  return parsed;
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
