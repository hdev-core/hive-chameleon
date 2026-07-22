import { randomBytes } from 'node:crypto';

export interface GoogleOidcConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: ReadonlySet<string>;
}

export interface AuthConfig {
  readonly accessTokenTtlSeconds: number;
  readonly audience: string;
  readonly challengeTtlSeconds: number;
  readonly google: GoogleOidcConfig | null;
  readonly hiveChainId: string;
  readonly hiveRpcUrl: string;
  readonly identityLookupKey: Buffer;
  readonly issuer: string;
  readonly refreshTokenTtlSeconds: number;
  readonly tokenKey: Buffer;
}

export function loadAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = environment.NODE_ENV === 'production';
  const tokenKey = readSecret(environment.AUTH_TOKEN_SECRET, 'AUTH_TOKEN_SECRET', production);
  const identityLookupKey = environment.AUTH_IDENTITY_LOOKUP_KEY
    ? decodeSecret(environment.AUTH_IDENTITY_LOOKUP_KEY, 'AUTH_IDENTITY_LOOKUP_KEY')
    : production
      ? missingSecret('AUTH_IDENTITY_LOOKUP_KEY')
      : tokenKey;

  const hiveRpcUrl = environment.HIVE_RPC_URL?.trim() || 'https://api.hive.blog/';
  assertHttpsEndpoint(hiveRpcUrl, 'HIVE_RPC_URL');
  const hiveChainId = environment.HIVE_CHAIN_ID?.trim() || '0'.repeat(64);
  if (!/^[0-9a-f]{64}$/.test(hiveChainId)) {
    throw new Error('HIVE_CHAIN_ID must be 32 lowercase hexadecimal bytes.');
  }

  return {
    accessTokenTtlSeconds: readInteger(environment.AUTH_ACCESS_TTL_SECONDS, 900, 60, 3_600),
    audience: environment.AUTH_TOKEN_AUDIENCE?.trim() || 'hive-chameleon-client',
    challengeTtlSeconds: readInteger(environment.AUTH_CHALLENGE_TTL_SECONDS, 300, 60, 900),
    google: readGoogleConfig(environment, production),
    hiveChainId,
    hiveRpcUrl,
    identityLookupKey,
    issuer: environment.AUTH_TOKEN_ISSUER?.trim() || 'hive-chameleon-api',
    refreshTokenTtlSeconds: readInteger(
      environment.AUTH_REFRESH_TTL_SECONDS,
      30 * 24 * 60 * 60,
      3_600,
      90 * 24 * 60 * 60,
    ),
    tokenKey,
  };
}

function readGoogleConfig(
  environment: NodeJS.ProcessEnv,
  production: boolean,
): GoogleOidcConfig | null {
  const clientId = environment.GOOGLE_OIDC_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_OIDC_CLIENT_SECRET?.trim();
  const redirectValues = (environment.GOOGLE_OIDC_REDIRECT_URIS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!clientId && !clientSecret && redirectValues.length === 0) {
    return null;
  }
  if (!clientId || !clientSecret || redirectValues.length === 0) {
    throw new Error(
      'Google OIDC requires GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET, and GOOGLE_OIDC_REDIRECT_URIS together.',
    );
  }
  const redirectUris = new Set(
    redirectValues.map((value) => canonicalRedirectUri(value, production)),
  );
  return { clientId, clientSecret, redirectUris };
}

function canonicalRedirectUri(value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GOOGLE_OIDC_REDIRECT_URIS must contain absolute HTTP or HTTPS URLs.');
  }
  const localDevelopment =
    !production &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (!localDevelopment && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'GOOGLE_OIDC_REDIRECT_URIS must use HTTPS (except local development) and contain no credentials or fragment.',
    );
  }
  return url.toString();
}

function readSecret(value: string | undefined, name: string, required: boolean): Buffer {
  if (!value) {
    if (required) {
      return missingSecret(name);
    }
    return randomBytes(32);
  }
  return decodeSecret(value, name);
}

function decodeSecret(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(value)) {
    throw new Error(`${name} must be an unpadded base64url value containing at least 32 bytes.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return decoded;
}

function missingSecret(name: string): never {
  throw new Error(`${name} is required in production.`);
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Authentication TTL must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Authentication TTL must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function assertHttpsEndpoint(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`${name} must be HTTPS without credentials, query, or fragment.`);
  }
}
