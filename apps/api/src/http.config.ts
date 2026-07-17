export interface HttpConfig {
  readonly corsAllowedOrigins: readonly string[];
  readonly port: number;
}

export function loadHttpConfig(environment: NodeJS.ProcessEnv = process.env): HttpConfig {
  const rawPort = environment.PORT?.trim() || '3000';
  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const port = Number.parseInt(rawPort, 10);
  if (port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const corsAllowedOrigins = [
    ...new Set(
      (environment.HTTP_CORS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => canonicalHttpOrigin(value, environment.NODE_ENV === 'production')),
    ),
  ];

  return { corsAllowedOrigins, port };
}

function canonicalHttpOrigin(value: string, requireHttps: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('HTTP_CORS_ALLOWED_ORIGINS must contain absolute HTTP or HTTPS origins.');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.origin !== value
  ) {
    throw new Error(
      'HTTP_CORS_ALLOWED_ORIGINS must contain canonical HTTP or HTTPS origins without paths, credentials, queries, or wildcards.',
    );
  }

  if (requireHttps && parsed.protocol !== 'https:') {
    throw new Error('HTTP_CORS_ALLOWED_ORIGINS must use HTTPS in production.');
  }

  return parsed.origin;
}
