import { createHmac, randomBytes } from 'node:crypto';

import { Client, Session } from '@heroiclabs/nakama-js';

const requiredEnvironment = [
  'NAKAMA_SERVER_KEY',
  'NAKAMA_BRIDGE_HMAC_KEY',
  'AUTH_TOKEN_SECRET',
  'SMOKE_AUTH_SESSION_ID',
  'SMOKE_AUTH_SESSION_TWO_ID',
  'SMOKE_PLAYER_ID',
  'SMOKE_PLAYER_TWO_ID',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

const apiUrl = new URL(
  '/api/v1/realtime/session',
  process.env.HIVE_CHAMELEON_API_URL ?? 'http://127.0.0.1:3000',
);
const nakamaUrl = new URL(process.env.NAKAMA_HTTP_URL ?? 'http://127.0.0.1:7350');
const client = new Client(
  process.env.NAKAMA_SERVER_KEY,
  nakamaUrl.hostname,
  nakamaUrl.port || (nakamaUrl.protocol === 'https:' ? '443' : '80'),
  nakamaUrl.protocol === 'https:',
  5_000,
  false,
);

let deviceAuthenticationRejected = false;
try {
  await client.authenticateDevice(randomBytes(32).toString('hex'), true, undefined, {
    app_auth_session_id: process.env.SMOKE_AUTH_SESSION_ID,
    app_player_id: process.env.SMOKE_PLAYER_ID,
    bridge_version: 'v1',
  });
} catch {
  deviceAuthenticationRejected = true;
}

if (!deviceAuthenticationRejected) {
  throw new Error('Nakama accepted a non-bridge device authentication attempt');
}

const replayAssertion = createBridgeAssertion({
  authSessionId: process.env.SMOKE_AUTH_SESSION_ID,
  bridgeKey: process.env.NAKAMA_BRIDGE_HMAC_KEY,
  playerId: process.env.SMOKE_PLAYER_ID,
});
const directBridgeSession = await client.authenticateCustom(replayAssertion, true);

let bridgeAssertionReplayRejected = false;
try {
  await client.authenticateCustom(replayAssertion, true);
} catch {
  bridgeAssertionReplayRejected = true;
}
if (!bridgeAssertionReplayRejected) {
  throw new Error('Nakama accepted a bridge assertion more than once');
}

let customIdentityPreclaimRejected = false;
try {
  await client.linkCustom(directBridgeSession, { id: process.env.SMOKE_AUTH_SESSION_ID });
} catch {
  customIdentityPreclaimRejected = true;
}
if (!customIdentityPreclaimRejected) {
  throw new Error('Nakama allowed a bridged user to preclaim another custom identity');
}

const response = await fetch(apiUrl, {
  headers: {
    authorization: `Bearer ${createAccessToken()}`,
  },
  method: 'POST',
});
if (!response.ok) {
  throw new Error(`NestJS realtime bridge returned HTTP ${response.status}`);
}
if (response.headers.get('cache-control') !== 'no-store') {
  throw new Error('NestJS realtime bridge response must use Cache-Control: no-store');
}

const credential = await response.json();
if (
  typeof credential.nakamaToken !== 'string' ||
  typeof credential.socketUrl !== 'string' ||
  typeof credential.expiresAt !== 'string'
) {
  throw new Error('NestJS realtime bridge returned an invalid credential');
}

const session = Session.restore(credential.nakamaToken, '');
const secondSession = await client.authenticateCustom(
  createBridgeAssertion({
    authSessionId: process.env.SMOKE_AUTH_SESSION_TWO_ID,
    bridgeKey: process.env.NAKAMA_BRIDGE_HMAC_KEY,
    playerId: process.env.SMOKE_PLAYER_TWO_ID,
  }),
  true,
);
const hostSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
const guestSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
const hostStates = trackLobbyStates(hostSocket);
const guestStates = trackLobbyStates(guestSocket);

try {
  await hostSocket.connect(session, true, 1_000);
  await guestSocket.connect(secondSession, true, 1_000);

  const created = await lobbyRpc(hostSocket, 'lobby.create', {
    max_players: 2,
    name: 'Bridge smoke lobby',
    region_code: 'local',
    visibility: 'public',
  });
  assertLobby(created, {
    host: process.env.SMOKE_PLAYER_ID,
    members: 1,
    version: 1,
  });
  if (typeof created.match_id !== 'string' || created.match_id.length === 0) {
    throw new Error('lobby.create did not return an authoritative match ID');
  }
  await hostSocket.joinMatch(created.match_id);

  const joined = await lobbyRpc(guestSocket, 'lobby.join', {
    join_source: 'server_browser',
    lobby_id: created.lobby.id,
  });
  assertLobby(joined, {
    host: process.env.SMOKE_PLAYER_ID,
    members: 2,
    version: 2,
  });
  if (joined.match_id !== created.match_id) {
    throw new Error('lobby.join resolved a different authoritative match');
  }
  await guestSocket.joinMatch(joined.match_id);
  await guestStates.waitFor(
    (state) => state.id === created.lobby.id && state.members.length === 2,
    'two-player lobby state',
  );

  const configured = await lobbyRpc(hostSocket, 'lobby.update_configuration', {
    expected_lobby_version: joined.lobby.row_version,
    hiding_duration_seconds: 90,
    hunting_duration_seconds: 240,
    lobby_id: created.lobby.id,
    shell_limit: 8,
  });
  assertLobby(configured, {
    host: process.env.SMOKE_PLAYER_ID,
    members: 2,
    version: 3,
  });
  if (
    configured.lobby.configuration.hiding_duration_seconds !== 90 ||
    configured.lobby.configuration.hunting_duration_seconds !== 240 ||
    configured.lobby.configuration.shell_limit !== 8
  ) {
    throw new Error('host configuration was not persisted');
  }

  const started = await lobbyRpc(hostSocket, 'lobby.start', {
    expected_lobby_version: configured.lobby.row_version,
    lobby_id: created.lobby.id,
  });
  assertLobby(started, {
    host: process.env.SMOKE_PLAYER_ID,
    members: 2,
    version: 4,
  });
  if (started.start_accepted !== true) {
    throw new Error('lobby.start was not accepted');
  }

  hostSocket.disconnect(false);
  const migrated = await guestStates.waitFor(
    (state) =>
      state.id === created.lobby.id &&
      state.current_host_player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.members.length === 1,
    'host migration after disconnect',
  );

  let staleVersionRejected = false;
  try {
    await lobbyRpc(guestSocket, 'lobby.update_configuration', {
      expected_lobby_version: started.lobby.row_version,
      lobby_id: created.lobby.id,
      shell_limit: 9,
    });
  } catch (error) {
    staleVersionRejected = String(error?.message).includes('lobby version changed');
  }
  if (!staleVersionRejected) {
    throw new Error('new host command accepted a stale lobby version');
  }

  const migratedHostUpdate = await lobbyRpc(guestSocket, 'lobby.update_configuration', {
    expected_lobby_version: migrated.row_version,
    lobby_id: created.lobby.id,
    shell_limit: 9,
  });
  if (
    migratedHostUpdate.lobby.current_host_player_id !== process.env.SMOKE_PLAYER_TWO_ID ||
    migratedHostUpdate.lobby.configuration.shell_limit !== 9
  ) {
    throw new Error('migrated host could not configure the persistent lobby');
  }

  const closed = await lobbyRpc(guestSocket, 'lobby.leave', {
    lobby_id: created.lobby.id,
  });
  if (!closed.lobby.closed || closed.lobby.members.length !== 0) {
    throw new Error('last player leave did not close the persistent lobby');
  }

  console.log(
    JSON.stringify({
      bridgeSessionConnected: true,
      bridgeAssertionReplayRejected,
      customIdentityPreclaimRejected,
      deviceAuthenticationRejected,
      lobbyLifecycle: 'create_join_configure_start_leave',
      hostMigration: 'disconnect',
      staleHostVersionRejected: staleVersionRejected,
    }),
  );
} finally {
  hostSocket.disconnect(false);
  guestSocket.disconnect(false);
}

function createBridgeAssertion({ authSessionId, bridgeKey, playerId }) {
  const expiresAt = Math.floor(Date.now() / 1_000) + 30;
  const nonce = randomBytes(16).toString('base64url');
  const payload = [
    'v1',
    compactUuid(playerId),
    compactUuid(authSessionId),
    expiresAt.toString(36),
    nonce,
  ].join('.');
  const signature = createHmac('sha256', Buffer.from(bridgeKey, 'base64url'))
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function createAccessToken() {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: 'hive-chameleon-client',
      exp: now + 300,
      iat: now,
      iss: 'hive-chameleon-api',
      sid: process.env.SMOKE_AUTH_SESSION_ID,
      sub: process.env.SMOKE_PLAYER_ID,
      typ: 'access',
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', Buffer.from(process.env.AUTH_TOKEN_SECRET, 'base64url'))
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

function compactUuid(value) {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('Bridge smoke identity must be a canonical lowercase UUID');
  }
  return Buffer.from(hex, 'hex').toString('base64url');
}

async function lobbyRpc(socket, id, payload) {
  const result = await socket.rpc(id, JSON.stringify(payload));
  if (typeof result?.payload !== 'string') {
    throw new Error(`${id} returned an invalid payload`);
  }
  return JSON.parse(result.payload);
}

function assertLobby(response, expected) {
  if (
    response?.lobby?.current_host_player_id !== expected.host ||
    response?.lobby?.members?.length !== expected.members ||
    response?.lobby?.row_version !== expected.version
  ) {
    throw new Error(
      `Unexpected lobby snapshot: ${JSON.stringify({
        host: response?.lobby?.current_host_player_id,
        members: response?.lobby?.members?.length,
        version: response?.lobby?.row_version,
      })}`,
    );
  }
}

function trackLobbyStates(socket) {
  let latest;
  const waiters = new Set();
  socket.onmatchdata = (message) => {
    if (Number(message.op_code) !== 1) {
      return;
    }
    const state = JSON.parse(new TextDecoder().decode(message.data));
    latest = state;
    for (const waiter of waiters) {
      if (waiter.predicate(state)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(state);
      }
    }
  };
  return {
    waitFor(predicate, description) {
      if (latest && predicate(latest)) {
        return Promise.resolve(latest);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${description}`));
          }, 10_000),
        };
        waiters.add(waiter);
      });
    },
  };
}
