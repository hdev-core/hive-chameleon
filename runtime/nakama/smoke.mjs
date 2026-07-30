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
  'SMOKE_MAP_VERSION_ID',
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
const returningHostSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
const hostStates = trackMatchStates(hostSocket);
const guestStates = trackMatchStates(guestSocket);
const returningHostStates = trackMatchStates(returningHostSocket);

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
  await guestStates.waitForLobby(
    (state) => state.id === created.lobby.id && state.members.length === 2,
    'two-player lobby state',
  );

  hostSocket.disconnect(false);
  const migrated = await guestStates.waitForLobby(
    (state) =>
      state.id === created.lobby.id &&
      state.current_host_player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.members.length === 1,
    'host migration after disconnect',
  );

  const migratedHostUpdate = await lobbyRpc(guestSocket, 'lobby.update_configuration', {
    expected_lobby_version: migrated.row_version,
    lobby_id: created.lobby.id,
    shell_limit: 9,
  });
  assertLobby(migratedHostUpdate, {
    host: process.env.SMOKE_PLAYER_TWO_ID,
    members: 1,
    version: 4,
  });

  await returningHostSocket.connect(session, true, 1_000);
  const rejoined = await lobbyRpc(returningHostSocket, 'lobby.join', {
    join_source: 'reconnect',
    lobby_id: created.lobby.id,
  });
  assertLobby(rejoined, {
    host: process.env.SMOKE_PLAYER_TWO_ID,
    members: 2,
    version: 5,
  });
  await returningHostSocket.joinMatch(rejoined.match_id);
  await returningHostStates.waitForLobby(
    (state) => state.id === created.lobby.id && state.members.length === 2,
    'returning two-player lobby state',
  );

  let forgedRoleRejected = false;
  try {
    await lobbyRpc(guestSocket, 'lobby.nominate_hunter', {
      expected_lobby_version: rejoined.lobby.row_version,
      lobby_id: created.lobby.id,
      nominated: true,
      role: 'hunter',
    });
  } catch {
    forgedRoleRejected = true;
  }
  if (!forgedRoleRejected) {
    throw new Error('lobby.nominate_hunter accepted a client-supplied role');
  }

  const nominated = await lobbyRpc(guestSocket, 'lobby.nominate_hunter', {
    expected_lobby_version: rejoined.lobby.row_version,
    lobby_id: created.lobby.id,
    nominated: true,
  });
  assertLobby(nominated, {
    host: process.env.SMOKE_PLAYER_TWO_ID,
    members: 2,
    version: 6,
  });
  if (
    nominated.lobby.hunter_nominee_player_ids.length !== 1 ||
    nominated.lobby.hunter_nominee_player_ids[0] !== process.env.SMOKE_PLAYER_TWO_ID
  ) {
    throw new Error('authenticated Hunter nomination was not published in lobby state');
  }

  const configured = await lobbyRpc(guestSocket, 'lobby.update_configuration', {
    expected_lobby_version: nominated.lobby.row_version,
    hiding_duration_seconds: 10,
    hunting_duration_seconds: 30,
    lobby_id: created.lobby.id,
    map_version_id: process.env.SMOKE_MAP_VERSION_ID,
    reload_duration_ms: 100,
    shell_limit: 6,
  });
  assertLobby(configured, {
    host: process.env.SMOKE_PLAYER_TWO_ID,
    members: 2,
    version: 7,
  });
  if (
    configured.lobby.configuration.hiding_duration_seconds !== 10 ||
    configured.lobby.configuration.hunting_duration_seconds !== 30 ||
    configured.lobby.configuration.reload_duration_ms !== 100 ||
    configured.lobby.configuration.shell_limit !== 6
  ) {
    throw new Error('host configuration was not persisted');
  }
  if (
    configured.lobby.hunter_nominee_player_ids.length !== 1 ||
    configured.lobby.hunter_nominee_player_ids[0] !== process.env.SMOKE_PLAYER_TWO_ID
  ) {
    throw new Error('Hunter nomination did not survive a durable lobby snapshot refresh');
  }

  const started = await lobbyRpc(guestSocket, 'lobby.start', {
    expected_lobby_version: configured.lobby.row_version,
    lobby_id: created.lobby.id,
  });
  assertLobby(started, {
    host: process.env.SMOKE_PLAYER_TWO_ID,
    members: 2,
    version: 8,
  });
  if (
    started.start_accepted !== true ||
    typeof started.round?.id !== 'string' ||
    started.round.status !== 'preparing' ||
    started.round.sequence_number !== 1
  ) {
    throw new Error('lobby.start did not create a preparing round');
  }
  if (started.lobby.hunter_nominee_player_ids.length !== 0) {
    throw new Error('consumed Hunter nominations were not cleared at round start');
  }

  const guestRole = await guestStates.waitForRole(
    (assignment) => assignment.player_id === process.env.SMOKE_PLAYER_TWO_ID,
    'nominated guest role assignment',
  );
  const returningHostRole = await returningHostStates.waitForRole(
    (assignment) => assignment.player_id === process.env.SMOKE_PLAYER_ID,
    'returning host role assignment',
  );
  if (
    guestRole.round_id !== started.round.id ||
    guestRole.role !== 'hunter' ||
    guestRole.hunter_volunteer !== true ||
    returningHostRole.round_id !== started.round.id ||
    returningHostRole.role !== 'hider' ||
    returningHostRole.hunter_volunteer !== false
  ) {
    throw new Error('server role assignment did not prioritize the authenticated volunteer');
  }
  await guestStates.waitForRound(
    (round) => round.id === started.round.id && round.status === 'preparing',
    'public preparing-round state',
  );
  const guestPlayerState = await guestStates.waitForPlayerState(
    (state) => state.round_id === started.round.id && state.role === 'hunter',
    'private Hunter simulation state',
  );
  const hiderPlayerState = await returningHostStates.waitForPlayerState(
    (state) =>
      state.round_id === started.round.id && state.role === 'hider' && state.hiding_slot > 0,
    'private Hider simulation state',
  );
  if (
    guestPlayerState.shells_remaining !== 6 ||
    hiderPlayerState.player_id !== process.env.SMOKE_PLAYER_ID
  ) {
    throw new Error('private Casual simulation state was not recipient-correct');
  }

  let staleVersionRejected = false;
  try {
    await lobbyRpc(guestSocket, 'lobby.update_configuration', {
      expected_lobby_version: configured.lobby.row_version,
      lobby_id: created.lobby.id,
      shell_limit: 9,
    });
  } catch (error) {
    staleVersionRejected = String(error?.message).includes('lobby version changed');
  }
  if (!staleVersionRejected) {
    throw new Error('new host command accepted a stale lobby version');
  }

  let lateNominationRejected = false;
  try {
    await lobbyRpc(returningHostSocket, 'lobby.nominate_hunter', {
      expected_lobby_version: started.lobby.row_version,
      lobby_id: created.lobby.id,
      nominated: true,
    });
  } catch {
    lateNominationRejected = true;
  }
  if (!lateNominationRejected) {
    throw new Error('Hunter nomination remained open after round start');
  }

  const hunting = await guestStates.waitForRound(
    (round) => round.id === started.round.id && round.status === 'hunting',
    'server-timed hunting phase',
    20_000,
  );
  if (
    hunting.hiders_remaining !== 1 ||
    hunting.hiders_total !== 1 ||
    hunting.target_slot_count < 3
  ) {
    throw new Error('public Casual hunting state is invalid');
  }

  await guestSocket.sendMatchState(
    created.match_id,
    10,
    JSON.stringify({
      aim_slot: hiderPlayerState.hiding_slot,
      command_id: 'forged-hit',
      hit: true,
    }),
  );
  const forgedHit = await guestStates.waitForFireResult(
    (result) => result.reason === 'invalid_command',
    'client-declared hit rejection',
  );
  if (forgedHit.accepted) {
    throw new Error('authoritative match accepted a client-declared hit');
  }

  await returningHostSocket.sendMatchState(
    created.match_id,
    10,
    JSON.stringify({
      aim_slot: hiderPlayerState.hiding_slot,
      command_id: 'hider-forged-shot',
    }),
  );
  const hiderFire = await returningHostStates.waitForFireResult(
    (result) => result.command_id === 'hider-forged-shot',
    'Hider fire rejection',
  );
  if (hiderFire.accepted || hiderFire.reason !== 'not_hunter') {
    throw new Error('authoritative match accepted a Hider fire intent');
  }

  await guestSocket.sendMatchState(
    created.match_id,
    10,
    JSON.stringify({
      aim_slot: hiderPlayerState.hiding_slot,
      command_id: 'authoritative-hit',
    }),
  );
  const authoritativeHit = await guestStates.waitForFireResult(
    (result) => result.command_id === 'authoritative-hit',
    'authoritative Hunter fire result',
  );
  const discovery = await guestStates.waitForDiscovery(
    (state) => state.round_id === started.round.id && state.sequence === 1,
    'authoritative discovery event',
  );
  const terminalRound = await guestStates.waitForRound(
    (round) => round.id === started.round.id && round.status === 'terminal',
    'terminal Casual round',
  );
  if (
    !authoritativeHit.accepted ||
    !authoritativeHit.hit ||
    authoritativeHit.hider_player_id !== process.env.SMOKE_PLAYER_ID ||
    discovery.hider_player_id !== process.env.SMOKE_PLAYER_ID ||
    terminalRound.winning_side !== 'hunters' ||
    terminalRound.completion_reason !== 'all_hiders_found' ||
    terminalRound.hiders_remaining !== 0
  ) {
    throw new Error('Casual round did not resolve an authoritative Hunter win');
  }

  returningHostSocket.disconnect(false);
  await guestStates.waitForLobby(
    (state) => state.id === created.lobby.id && state.members.length === 1,
    'round participant disconnect',
  );
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
      lobbyLifecycle: 'create_join_migrate_rejoin_nominate_configure_start_leave',
      hostMigration: 'disconnect',
      roundScaffolding: 'preparing',
      casualRound: 'terminal_hunter_win',
      clientDeclaredHitRejected: true,
      serverAssignedRoles: true,
      forgedRoleRejected,
      lateNominationRejected,
      staleHostVersionRejected: staleVersionRejected,
    }),
  );
} finally {
  hostSocket.disconnect(false);
  guestSocket.disconnect(false);
  returningHostSocket.disconnect(false);
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

function trackMatchStates(socket) {
  const latest = new Map();
  const waiters = new Map([
    [1, new Set()],
    [2, new Set()],
    [3, new Set()],
    [4, new Set()],
    [5, new Set()],
    [6, new Set()],
  ]);
  socket.onmatchdata = (message) => {
    const opcode = Number(message.op_code);
    const opcodeWaiters = waiters.get(opcode);
    if (!opcodeWaiters) {
      return;
    }
    const state = JSON.parse(new TextDecoder().decode(message.data));
    latest.set(opcode, state);
    for (const waiter of opcodeWaiters) {
      if (waiter.predicate(state)) {
        clearTimeout(waiter.timeout);
        opcodeWaiters.delete(waiter);
        waiter.resolve(state);
      }
    }
  };
  function waitFor(opcode, predicate, description, timeoutMs = 10_000) {
    const current = latest.get(opcode);
    if (current && predicate(current)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const opcodeWaiters = waiters.get(opcode);
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          opcodeWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}`));
        }, timeoutMs),
      };
      opcodeWaiters.add(waiter);
    });
  }
  return {
    waitForLobby: (predicate, description) => waitFor(1, predicate, description),
    waitForRole: (predicate, description) => waitFor(2, predicate, description),
    waitForRound: (predicate, description, timeoutMs) =>
      waitFor(3, predicate, description, timeoutMs),
    waitForDiscovery: (predicate, description) => waitFor(4, predicate, description),
    waitForPlayerState: (predicate, description) => waitFor(5, predicate, description),
    waitForFireResult: (predicate, description) => waitFor(6, predicate, description),
  };
}
