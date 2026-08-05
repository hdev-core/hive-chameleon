#!/usr/bin/env node

import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDirectory = join(repositoryRoot, '.cache', 'authoritative-development');
const statePath = join(cacheDirectory, 'state.json');
const logDirectory = join(cacheDirectory, 'logs');
const editorConfigurationPath = join(
  repositoryRoot,
  'clients',
  'unity',
  'Library',
  'HiveChameleon',
  'AuthoritativeDevelopment.json',
);
const webGlBuildPath = join(repositoryRoot, 'clients', 'unity', 'Builds', 'WebGL');
const applicationComposeFile = join(repositoryRoot, 'infra', 'postgres', 'compose.yaml');
const nakamaComposeFile = join(repositoryRoot, 'runtime', 'nakama', 'compose.yaml');
const applicationProject = 'hive-chameleon-authoritative-application';
const nakamaProject = 'hive-chameleon-authoritative';
const maximumClients = 10;
const accessTokenLifetimeSeconds = 3_600;
const sessionLifetimeSeconds = 8 * 60 * 60;
const stateVersion = 1;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.data', 'application/octet-stream'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
]);

function usage() {
  return `Hive Chameleon authoritative development

Usage:
  node scripts/authoritative-development.mjs start [--clients 1..10]
  node scripts/authoritative-development.mjs clients --count 1..10
  node scripts/authoritative-development.mjs use --client 1..10
  node scripts/authoritative-development.mjs status
  node scripts/authoritative-development.mjs restart [--clients 1..10]
  node scripts/authoritative-development.mjs webgl [--clients 1..10] [--no-build]
  node scripts/authoritative-development.mjs logs [api|nakama|postgres]
  node scripts/authoritative-development.mjs stop
  node scripts/authoritative-development.mjs clean`;
}

export function parseClientCount(value, fallback = 1) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximumClients) {
    throw new Error(`Client count must be an integer between 1 and ${maximumClients}.`);
  }
  return candidate;
}

function optionValue(arguments_, names) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    for (const name of names) {
      if (argument === name) {
        const value = arguments_[index + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new Error(`${name} requires a value.`);
        }
        return value;
      }
      if (argument.startsWith(`${name}=`)) {
        return argument.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function hasOption(arguments_, name) {
  return arguments_.includes(name);
}

export function clientPlayerId(slot) {
  const client = parseClientCount(slot);
  return `01920000-0000-7000-8000-${client.toString(16).padStart(12, '0')}`;
}

function randomBase64Url(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function randomUuidV7() {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = bytes.toString('hex');
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join('-');
}

async function freePort(usedPorts) {
  for (;;) {
    const port = await new Promise((resolvePort, reject) => {
      const server = createNetServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolvePort(address.port));
      });
    });
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
}

async function createState() {
  const usedPorts = new Set();
  const ports = {
    api: await freePort(usedPorts),
    applicationPostgres: await freePort(usedPorts),
    nakamaApi: await freePort(usedPorts),
    nakamaConsole: await freePort(usedPorts),
    nakamaMetrics: await freePort(usedPorts),
    webgl: await freePort(usedPorts),
  };
  return {
    version: stateVersion,
    projects: {
      application: applicationProject,
      nakama: nakamaProject,
    },
    ports,
    secrets: {
      authIdentityLookupKey: randomBase64Url(32),
      authTokenSecret: randomBase64Url(32),
      nakamaBridgeHmacKey: randomBase64Url(32),
      nakamaConsolePassword: randomHex(24),
      nakamaConsoleSigningKey: randomHex(32),
      nakamaDatabasePassword: randomHex(24),
      nakamaRefreshEncryptionKey: randomHex(32),
      nakamaRuntimeHttpKey: randomHex(24),
      nakamaServerKey: randomHex(24),
      nakamaSessionEncryptionKey: randomHex(32),
    },
    clients: [],
    selectedClient: 1,
    apiPid: null,
    webglPid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeJsonPrivate(path, value) {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJsonPrivate(statePath, state);
}

function loadState({ required = true } = {}) {
  if (!existsSync(statePath)) {
    if (required) {
      throw new Error(
        'The authoritative stack has not been initialized. Run npm run authoritative:start.',
      );
    }
    return null;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error(`Authoritative state is unreadable: ${statePath}`);
  }
  if (
    state?.version !== stateVersion ||
    !state.ports ||
    !state.secrets ||
    !Array.isArray(state.clients)
  ) {
    throw new Error(
      'Authoritative state has an unsupported format. Run npm run authoritative:clean.',
    );
  }
  return state;
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : options.input
        ? ['pipe', 'inherit', 'inherit']
        : 'inherit',
  });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} exited with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return options.capture
    ? {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    : { status: result.status, stdout: '', stderr: '' };
}

function requireCommand(command) {
  const result = run(command, ['--version'], { capture: true, allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`${command} is required but was not found.`);
  }
}

function composeEnvironment(state) {
  return {
    ...process.env,
    HC_NAKAMA_DATABASE_URL: `postgres://postgres:postgres@host.docker.internal:${state.ports.applicationPostgres}/hive_chameleon?sslmode=disable`,
    HC_POSTGRES_PORT: String(state.ports.applicationPostgres),
    NAKAMA_API_PORT: String(state.ports.nakamaApi),
    NAKAMA_BRIDGE_HMAC_KEY: state.secrets.nakamaBridgeHmacKey,
    NAKAMA_CONSOLE_PASSWORD: state.secrets.nakamaConsolePassword,
    NAKAMA_CONSOLE_PORT: String(state.ports.nakamaConsole),
    NAKAMA_CONSOLE_SIGNING_KEY: state.secrets.nakamaConsoleSigningKey,
    NAKAMA_CONSOLE_USERNAME: 'local-admin',
    NAKAMA_DATABASE_PASSWORD: state.secrets.nakamaDatabasePassword,
    NAKAMA_METRICS_PORT: String(state.ports.nakamaMetrics),
    NAKAMA_REFRESH_ENCRYPTION_KEY: state.secrets.nakamaRefreshEncryptionKey,
    NAKAMA_RUNTIME_HTTP_KEY: state.secrets.nakamaRuntimeHttpKey,
    NAKAMA_SERVER_KEY: state.secrets.nakamaServerKey,
    NAKAMA_SESSION_ENCRYPTION_KEY: state.secrets.nakamaSessionEncryptionKey,
  };
}

function applicationCompose(state, arguments_, options = {}) {
  return run(
    'docker',
    [
      'compose',
      '--project-name',
      applicationProject,
      '--file',
      applicationComposeFile,
      ...arguments_,
    ],
    { ...options, env: composeEnvironment(state) },
  );
}

function nakamaCompose(state, arguments_, options = {}) {
  return run(
    'docker',
    ['compose', '--project-name', nakamaProject, '--file', nakamaComposeFile, ...arguments_],
    { ...options, env: composeEnvironment(state) },
  );
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMilliseconds, failureMessage) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(failureMessage);
}

function composeServiceStatus(compose, state, service) {
  const result = compose(state, ['ps', '--quiet', service], {
    capture: true,
    allowFailure: true,
  });
  const containerId = result.stdout.trim();
  if (!containerId) {
    return 'stopped';
  }
  const inspection = run(
    'docker',
    [
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      containerId,
    ],
    { capture: true, allowFailure: true },
  );
  return inspection.status === 0 ? inspection.stdout.trim() : 'unknown';
}

async function apiHealthy(state) {
  try {
    const response = await fetch(`http://127.0.0.1:${state.ports.api}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function webGlHealthy(state) {
  if (!processIsRunning(state.webglPid)) {
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${state.ports.webgl}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stackHealthy(state) {
  return (
    composeServiceStatus(applicationCompose, state, 'postgres') === 'healthy' &&
    composeServiceStatus(nakamaCompose, state, 'nakama') === 'healthy' &&
    processIsRunning(state.apiPid) &&
    (await apiHealthy(state))
  );
}

function processMatches(pid, expectedCommandFragment) {
  if (!processIsRunning(pid)) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return (
    result.status === 0 &&
    typeof result.stdout === 'string' &&
    result.stdout.includes(expectedCommandFragment)
  );
}

function stopProcess(pid, expectedCommandFragment) {
  if (!processIsRunning(pid)) {
    return;
  }
  if (expectedCommandFragment && !processMatches(pid, expectedCommandFragment)) {
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processIsRunning(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (processIsRunning(pid)) {
    process.kill(pid, 'SIGKILL');
  }
}

function apiEnvironment(state) {
  return {
    ...process.env,
    AUTH_ACCESS_TTL_SECONDS: String(accessTokenLifetimeSeconds),
    AUTH_IDENTITY_LOOKUP_KEY: state.secrets.authIdentityLookupKey,
    AUTH_REFRESH_TTL_SECONDS: String(sessionLifetimeSeconds),
    AUTH_TOKEN_SECRET: state.secrets.authTokenSecret,
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${state.ports.applicationPostgres}/hive_chameleon?sslmode=disable`,
    HTTP_CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${state.ports.webgl}`,
    NAKAMA_BRIDGE_HMAC_KEY: state.secrets.nakamaBridgeHmacKey,
    NAKAMA_HTTP_URL: `http://127.0.0.1:${state.ports.nakamaApi}`,
    NAKAMA_SERVER_KEY: state.secrets.nakamaServerKey,
    NAKAMA_SOCKET_URL: `ws://127.0.0.1:${state.ports.nakamaApi}/ws`,
    NODE_ENV: 'development',
    PORT: String(state.ports.api),
  };
}

async function startApi(state) {
  stopProcess(state.apiPid, 'apps/api/dist/main.js');
  const apiLog = join(logDirectory, 'api.log');
  ensurePrivateDirectory(logDirectory);
  const logDescriptor = openSync(apiLog, 'a', 0o600);
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: repositoryRoot,
    detached: true,
    env: apiEnvironment(state),
    stdio: ['ignore', logDescriptor, logDescriptor],
  });
  child.unref();
  closeSync(logDescriptor);
  state.apiPid = child.pid;
  saveState(state);
  await waitFor(
    () => apiHealthy(state),
    60_000,
    `The API did not become ready. Inspect ${relative(repositoryRoot, apiLog)}.`,
  );
}

async function startInfrastructure(state) {
  requireCommand('docker');
  requireCommand('npm');

  console.log('Building the API...');
  run('npm', ['run', 'build', '--workspace', '@hive-chameleon/api']);

  console.log('Starting PostgreSQL and applying migrations...');
  applicationCompose(state, ['up', '--detach', 'postgres']);
  applicationCompose(state, ['run', '--rm', 'dbmate']);

  console.log('Building and starting Nakama...');
  nakamaCompose(state, ['up', '--build', '--detach', 'nakama']);
  await waitFor(
    () => composeServiceStatus(nakamaCompose, state, 'nakama') === 'healthy',
    120_000,
    'Nakama did not become healthy within 120 seconds.',
  );

  console.log('Starting the API...');
  await startApi(state);
}

function accessToken(state, client, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const sessionExpiration = Math.floor(new Date(client.sessionExpiresAt).getTime() / 1_000);
  const expiresAt = Math.min(issuedAt + accessTokenLifetimeSeconds, sessionExpiration);
  if (expiresAt <= issuedAt) {
    throw new Error(`Client ${client.slot} session has expired.`);
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: 'hive-chameleon-client',
      exp: expiresAt,
      iat: issuedAt,
      iss: 'hive-chameleon-api',
      sid: client.authSessionId,
      sub: client.playerId,
      typ: 'access',
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', Buffer.from(state.secrets.authTokenSecret, 'base64url'))
    .update(signingInput)
    .digest('base64url');
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}

function createClient(slot) {
  const now = new Date();
  return {
    slot,
    displayName: `Client ${slot}`,
    hiveUsername: `dev-client-${slot}`,
    playerId: clientPlayerId(slot),
    authSessionId: randomUuidV7(),
    refreshTokenHash: randomHex(32),
    sessionExpiresAt: new Date(now.getTime() + sessionLifetimeSeconds * 1_000).toISOString(),
    accessToken: '',
    accessTokenExpiresAt: now.toISOString(),
  };
}

function sessionNeedsReplacement(client, now = new Date()) {
  const expiration = new Date(client.sessionExpiresAt).getTime();
  return (
    !Number.isFinite(expiration) || expiration <= now.getTime() + accessTokenLifetimeSeconds * 1_000
  );
}

export const developmentClientProvisioningSql = String.raw`
BEGIN;

INSERT INTO identity.player (id, hive_username, hive_control_state)
VALUES (:'player_id', :'hive_username', 'external_self_custodial')
ON CONFLICT (id) DO UPDATE
SET hive_username = EXCLUDED.hive_username,
    hive_control_state = EXCLUDED.hive_control_state;

UPDATE identity.auth_session
SET revoked_at = now(),
    revocation_reason = 'superseded_login'
WHERE player_id = :'player_id'
  AND revoked_at IS NULL
  AND id <> :'session_id';

INSERT INTO identity.auth_session (
  id, player_id, refresh_token_hash, platform, authentication_method,
  hive_signing_provider, hive_control_state_at_issue, custodial_signing_eligible,
  issued_at, expires_at
) VALUES (
  :'session_id', :'player_id', :'refresh_token_hash', 'macos', 'direct_hive_challenge',
  'keychain', 'external_self_custodial', false, now(), :'session_expires_at'
)
ON CONFLICT (id) DO UPDATE
SET expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revocation_reason = NULL;

COMMIT;
`;

function provisionClient(state, client) {
  applicationCompose(
    state,
    [
      'exec',
      '--no-TTY',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'hive_chameleon',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `player_id=${client.playerId}`,
      '-v',
      `hive_username=${client.hiveUsername}`,
      '-v',
      `session_id=${client.authSessionId}`,
      '-v',
      `refresh_token_hash=${client.refreshTokenHash}`,
      '-v',
      `session_expires_at=${client.sessionExpiresAt}`,
    ],
    { input: developmentClientProvisioningSql },
  );
}

function ensureClients(state, count) {
  const requestedCount = parseClientCount(count);
  const now = new Date();
  for (let slot = 1; slot <= requestedCount; slot += 1) {
    let client = state.clients.find((candidate) => candidate.slot === slot);
    if (!client || sessionNeedsReplacement(client, now)) {
      client = createClient(slot);
      state.clients = state.clients.filter((candidate) => candidate.slot !== slot);
      state.clients.push(client);
    }
    provisionClient(state, client);
    const issued = accessToken(state, client, now);
    client.accessToken = issued.token;
    client.accessTokenExpiresAt = issued.expiresAt;
  }
  state.clients.sort((left, right) => left.slot - right.slot);
  if (!state.clients.some((client) => client.slot === state.selectedClient)) {
    state.selectedClient = 1;
  }
  saveState(state);
  writeEditorConfiguration(state);
}

function writeEditorConfiguration(state) {
  const clients = state.clients.map((client) => ({
    slot: client.slot,
    display_name: client.displayName,
    player_id: client.playerId,
    bearer_token: client.accessToken,
    expires_at: client.accessTokenExpiresAt,
  }));
  writeJsonPrivate(editorConfigurationPath, {
    version: stateVersion,
    api_base_url: `http://127.0.0.1:${state.ports.api}`,
    nakama_server_key: state.secrets.nakamaServerKey,
    selected_client: state.selectedClient,
    generated_at: new Date().toISOString(),
    clients,
  });
}

async function validateClientCredentials(state, slots) {
  for (const slot of slots) {
    const client = state.clients.find((candidate) => candidate.slot === slot);
    if (!client) {
      throw new Error(`Client ${slot} is not provisioned.`);
    }
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${state.ports.api}/api/v1/realtime/session`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${client.accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error(`Client ${slot} could not reach the realtime session endpoint.`);
    }
    if (!response.ok) {
      throw new Error(
        `Client ${slot} was rejected by the realtime session endpoint with HTTP ${response.status}.`,
      );
    }
    let credential;
    try {
      credential = await response.json();
    } catch {
      throw new Error(`Client ${slot} received an invalid realtime session response.`);
    }
    const expiration = new Date(credential?.expiresAt).getTime();
    if (
      typeof credential?.nakamaToken !== 'string' ||
      credential.nakamaToken.length < 32 ||
      typeof credential?.socketUrl !== 'string' ||
      !/^wss?:\/\//.test(credential.socketUrl) ||
      !Number.isFinite(expiration) ||
      expiration <= Date.now()
    ) {
      throw new Error(`Client ${slot} received an incomplete realtime session response.`);
    }
  }
}

function printReady(state) {
  const selected = state.clients.find((client) => client.slot === state.selectedClient);
  console.log('');
  console.log('Authoritative development is ready.');
  console.log(`API:    http://127.0.0.1:${state.ports.api}`);
  console.log(`Nakama: ws://127.0.0.1:${state.ports.nakamaApi}/ws`);
  console.log(
    selected
      ? `Unity Editor: ${selected.displayName} (token expires ${selected.accessTokenExpiresAt})`
      : 'Unity Editor: no client selected',
  );
  console.log('Open Unity normally and press Play.');
}

async function startCommand(arguments_) {
  const requestedCount = optionValue(arguments_, ['--clients', '--count']);
  let state = loadState({ required: false });
  if (!state) {
    state = await createState();
    saveState(state);
  }
  const count = parseClientCount(requestedCount, Math.max(1, state.clients.length));
  if (!(await stackHealthy(state))) {
    await startInfrastructure(state);
  } else {
    console.log('Authoritative services are already healthy; reusing them.');
  }
  ensureClients(state, count);
  await validateClientCredentials(
    state,
    Array.from({ length: count }, (_, index) => index + 1),
  );
  printReady(state);
}

async function clientsCommand(arguments_) {
  const count = parseClientCount(optionValue(arguments_, ['--clients', '--count']), 1);
  const state = loadState();
  if (!(await stackHealthy(state))) {
    throw new Error('Authoritative services are not healthy. Run npm run authoritative:start.');
  }
  ensureClients(state, count);
  await validateClientCredentials(
    state,
    Array.from({ length: count }, (_, index) => index + 1),
  );
  console.log(`Provisioned Client 1 through Client ${count}.`);
  console.log(`Selected Unity Editor identity: Client ${state.selectedClient}.`);
}

async function useCommand(arguments_) {
  const slot = parseClientCount(optionValue(arguments_, ['--client', '--slot']));
  const state = loadState();
  if (!(await stackHealthy(state))) {
    throw new Error('Authoritative services are not healthy. Run npm run authoritative:start.');
  }
  ensureClients(state, slot);
  await validateClientCredentials(state, [slot]);
  state.selectedClient = slot;
  saveState(state);
  writeEditorConfiguration(state);
  console.log(`Unity Editor will use Client ${slot} the next time Play starts.`);
}

function serviceSummary(state, name, value) {
  console.log(`${name.padEnd(12)} ${value}`);
}

async function statusCommand() {
  const state = loadState({ required: false });
  if (!state) {
    console.log('Authoritative development has not been initialized.');
    return;
  }
  serviceSummary(state, 'PostgreSQL', composeServiceStatus(applicationCompose, state, 'postgres'));
  serviceSummary(state, 'Nakama', composeServiceStatus(nakamaCompose, state, 'nakama'));
  serviceSummary(
    state,
    'API',
    processIsRunning(state.apiPid) && (await apiHealthy(state)) ? 'healthy' : 'stopped',
  );
  serviceSummary(state, 'WebGL', (await webGlHealthy(state)) ? 'healthy' : 'stopped');
  console.log(`API URL      http://127.0.0.1:${state.ports.api}`);
  console.log(`Nakama URL   ws://127.0.0.1:${state.ports.nakamaApi}/ws`);
  console.log(`Editor slot  Client ${state.selectedClient}`);
  if (state.clients.length === 0) {
    console.log('Clients      none');
  } else {
    for (const client of state.clients) {
      console.log(
        `Client ${String(client.slot).padEnd(6)} ${client.playerId}  expires ${client.accessTokenExpiresAt}`,
      );
    }
  }
}

async function stopCommand({ clean = false } = {}) {
  const state = loadState({ required: false });
  if (!state) {
    console.log('No authoritative development state was found.');
    return;
  }
  stopProcess(state.webglPid, 'authoritative-development.mjs serve-webgl');
  stopProcess(state.apiPid, 'apps/api/dist/main.js');
  state.webglPid = null;
  state.apiPid = null;

  nakamaCompose(
    state,
    [
      'down',
      ...(clean ? ['--volumes', '--remove-orphans', '--rmi', 'local'] : ['--remove-orphans']),
    ],
    { allowFailure: true },
  );
  applicationCompose(
    state,
    ['down', ...(clean ? ['--volumes', '--remove-orphans'] : ['--remove-orphans'])],
    { allowFailure: true },
  );
  rmSync(editorConfigurationPath, { force: true });

  if (clean) {
    rmSync(cacheDirectory, { force: true, recursive: true });
    console.log('Authoritative services, volumes, credentials, and cached state were removed.');
  } else {
    saveState(state);
    console.log(
      'Authoritative services stopped. Database volumes and local identities were preserved.',
    );
  }
}

async function restartCommand(arguments_) {
  const state = loadState({ required: false });
  const count = parseClientCount(
    optionValue(arguments_, ['--clients', '--count']),
    Math.max(1, state?.clients?.length ?? 0),
  );
  await stopCommand();
  await startCommand(['--clients', String(count)]);
}

function webGlArguments(state, client) {
  return [
    '--hc-authoritative-development',
    `--hc-api-base-url=http://127.0.0.1:${state.ports.api}`,
    `--hc-nakama-server-key=${state.secrets.nakamaServerKey}`,
    `--hc-bearer-token=${client.accessToken}`,
    `--hc-client-slot=${client.slot}`,
  ];
}

export function patchWebGlIndex(indexHtml, arguments_) {
  const pattern = /arguments\s*:\s*\[\s*\]\s*,/;
  if (!pattern.test(indexHtml)) {
    throw new Error('Unity WebGL index does not expose the expected config.arguments field.');
  }
  return indexHtml.replace(pattern, `arguments: ${JSON.stringify(arguments_)},`);
}

function safeWebGlFile(pathname, slot) {
  const prefix = `/client/${slot}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (!decoded || decoded === 'index.html') {
    return join(webGlBuildPath, 'index.html');
  }
  const candidate = resolve(webGlBuildPath, decoded);
  const rootWithSeparator = `${resolve(webGlBuildPath)}${sep}`;
  return candidate.startsWith(rootWithSeparator) ? candidate : null;
}

function respondText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Content-Type': contentType,
  });
  response.end(body);
}

async function serveWebGlCommand() {
  const state = loadState();
  const baseIndex = readFileSync(join(webGlBuildPath, 'index.html'), 'utf8');
  const server = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${state.ports.webgl}`);
    if (requestUrl.pathname === '/health') {
      respondText(response, 200, 'ok\n');
      return;
    }
    if (requestUrl.pathname === '/') {
      response.writeHead(302, { Location: '/client/1/' });
      response.end();
      return;
    }
    const match = /^\/client\/(\d+)(?:\/|$)/.exec(requestUrl.pathname);
    if (!match) {
      respondText(response, 404, 'Not found\n');
      return;
    }
    const slot = Number.parseInt(match[1], 10);
    if (requestUrl.pathname === `/client/${slot}`) {
      response.writeHead(302, { Location: `/client/${slot}/` });
      response.end();
      return;
    }
    const currentState = loadState();
    const client = currentState.clients.find((candidate) => candidate.slot === slot);
    if (!client) {
      respondText(response, 404, `Client ${slot} is not provisioned.\n`);
      return;
    }
    const filePath = safeWebGlFile(requestUrl.pathname, slot);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      respondText(response, 404, 'Not found\n');
      return;
    }
    if (filePath === join(webGlBuildPath, 'index.html')) {
      const html = patchWebGlIndex(baseIndex, webGlArguments(currentState, client));
      respondText(response, 200, html, 'text/html; charset=utf-8');
      return;
    }
    const statistics = statSync(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': statistics.size,
      'Content-Type': mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });
  server.listen(state.ports.webgl, '127.0.0.1', () => {
    console.log(`WebGL development server listening on http://127.0.0.1:${state.ports.webgl}`);
  });
}

async function webGlCommand(arguments_) {
  const count = parseClientCount(optionValue(arguments_, ['--clients', '--count']), 2);
  const state = loadState();
  if (!(await stackHealthy(state))) {
    throw new Error('Authoritative services are not healthy. Run npm run authoritative:start.');
  }
  const skipBuild = hasOption(arguments_, '--no-build');
  if (skipBuild && !existsSync(join(webGlBuildPath, 'index.html'))) {
    throw new Error('The WebGL build is missing. Run without --no-build.');
  }
  ensureClients(state, count);
  await validateClientCredentials(
    state,
    Array.from({ length: count }, (_, index) => index + 1),
  );
  if (!skipBuild) {
    console.log('Building one credential-neutral local WebGL client...');
    run('bash', ['scripts/build-unity-webgl.sh'], {
      env: {
        ...process.env,
        HIVE_CHAMELEON_CREDENTIAL_NEUTRAL_WEBGL: '1',
      },
    });
  }
  if (!existsSync(join(webGlBuildPath, 'index.html'))) {
    throw new Error('The WebGL build is missing. Run without --no-build.');
  }
  stopProcess(state.webglPid, 'authoritative-development.mjs serve-webgl');
  ensurePrivateDirectory(logDirectory);
  const webGlLog = join(logDirectory, 'webgl.log');
  const logDescriptor = openSync(webGlLog, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve-webgl'], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', logDescriptor, logDescriptor],
  });
  child.unref();
  closeSync(logDescriptor);
  state.webglPid = child.pid;
  saveState(state);
  await waitFor(
    () => webGlHealthy(state),
    10_000,
    `The WebGL server did not start. Inspect ${relative(repositoryRoot, webGlLog)}.`,
  );
  console.log('');
  console.log('Local WebGL clients:');
  for (let slot = 1; slot <= count; slot += 1) {
    console.log(`Client ${slot}: http://127.0.0.1:${state.ports.webgl}/client/${slot}/`);
  }
  console.log('Any client may create a lobby or join one; host is a dynamic lobby role.');
}

function redact(text, state) {
  let output = text;
  for (const secret of Object.values(state.secrets)) {
    output = output.split(secret).join('[REDACTED]');
  }
  for (const client of state.clients) {
    output = output.split(client.accessToken).join('[REDACTED]');
  }
  return output;
}

function tailFile(path, lines = 120) {
  if (!existsSync(path)) {
    return 'No log has been written yet.\n';
  }
  return `${readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')}\n`;
}

function logsCommand(arguments_) {
  const state = loadState();
  const service = arguments_[0] ?? 'api';
  let output;
  switch (service) {
    case 'api':
      output = tailFile(join(logDirectory, 'api.log'));
      break;
    case 'webgl':
      output = tailFile(join(logDirectory, 'webgl.log'));
      break;
    case 'nakama': {
      const result = nakamaCompose(state, ['logs', '--no-color', '--tail', '120', 'nakama'], {
        capture: true,
        allowFailure: true,
      });
      output = result.stdout || result.stderr;
      break;
    }
    case 'postgres': {
      const result = applicationCompose(
        state,
        ['logs', '--no-color', '--tail', '120', 'postgres'],
        { capture: true, allowFailure: true },
      );
      output = result.stdout || result.stderr;
      break;
    }
    default:
      throw new Error('Log service must be api, webgl, nakama, or postgres.');
  }
  process.stdout.write(redact(output, state));
}

async function main() {
  const [command = 'help', ...arguments_] = process.argv.slice(2);
  switch (command) {
    case 'start':
      await startCommand(arguments_);
      break;
    case 'clients':
      await clientsCommand(arguments_);
      break;
    case 'use':
      await useCommand(arguments_);
      break;
    case 'status':
      await statusCommand();
      break;
    case 'restart':
      await restartCommand(arguments_);
      break;
    case 'webgl':
      await webGlCommand(arguments_);
      break;
    case 'serve-webgl':
      await serveWebGlCommand();
      break;
    case 'logs':
      logsCommand(arguments_);
      break;
    case 'stop':
      await stopCommand();
      break;
    case 'clean':
      await stopCommand({ clean: true });
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      break;
    default:
      throw new Error(`Unknown authoritative development command: ${command}\n\n${usage()}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Authoritative development failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
