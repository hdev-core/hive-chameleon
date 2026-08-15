import { createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Client, Session } from '@heroiclabs/nakama-js';

const requiredEnvironment = [
  'NAKAMA_SERVER_KEY',
  'NAKAMA_BRIDGE_HMAC_KEY',
  'AUTH_TOKEN_SECRET',
  'SMOKE_AUTH_SESSION_ID',
  'SMOKE_AUTH_SESSION_TWO_ID',
  'SMOKE_PLAYER_ID',
  'SMOKE_PLAYER_TWO_ID',
  'SMOKE_NAKAMA_CONTAINER_ID',
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
const execFileAsync = promisify(execFile);

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
let guestSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
const returningHostSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
let reconnectedHiderSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
const hostStates = trackMatchStates(hostSocket);
let guestStates = trackMatchStates(guestSocket);
const returningHostStates = trackMatchStates(returningHostSocket);
let reconnectedHiderStates = trackMatchStates(reconnectedHiderSocket);

try {
  await hostSocket.connect(session, true, 1_000);
  await guestSocket.connect(secondSession, true, 1_000);

  const supersededHostLobby = await lobbyRpc(hostSocket, 'lobby.create', {
    max_players: 2,
    name: 'Superseded host lobby',
    region_code: 'local',
    visibility: 'public',
  });
  await hostSocket.joinMatch(supersededHostLobby.match_id);
  const supersededGuestLobby = await lobbyRpc(guestSocket, 'lobby.create', {
    max_players: 2,
    name: 'Superseded guest lobby',
    region_code: 'local',
    visibility: 'public',
  });
  await guestSocket.joinMatch(supersededGuestLobby.match_id);

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
  if (
    created.lobby.id === supersededHostLobby.lobby.id ||
    Object.hasOwn(created.lobby, 'departed_lobby_id')
  ) {
    throw new Error('lobby.create did not replace the previous lobby cleanly');
  }
  const officialMapVersionId = created.lobby.configuration?.map_version_id;
  if (typeof officialMapVersionId !== 'string' || officialMapVersionId.length === 0) {
    throw new Error('lobby.create did not select the current official map release');
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
  if (
    joined.lobby.id === supersededGuestLobby.lobby.id ||
    Object.hasOwn(joined.lobby, 'departed_lobby_id')
  ) {
    throw new Error('lobby.join did not switch away from the previous lobby cleanly');
  }
  const joinedNames = new Map(
    joined.lobby.members.map((member) => [member.player_id, member.display_name]),
  );
  if (
    joinedNames.get(process.env.SMOKE_PLAYER_ID) !== 'smoke-user' ||
    joinedNames.get(process.env.SMOKE_PLAYER_TWO_ID) !== 'smoke-user-two'
  ) {
    throw new Error('lobby roster did not carry authoritative Hive display names');
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
    hunting_duration_seconds: 60,
    lobby_id: created.lobby.id,
    map_version_id: officialMapVersionId,
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
    configured.lobby.configuration.hunting_duration_seconds !== 60 ||
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
    started.round.sequence_number !== 1 ||
    started.round.map_version_id !== officialMapVersionId ||
    started.round.map_slug !== 'neon-service-arcade' ||
    started.round.map_content_version !== 'm3' ||
    started.round.game_server_build_version !== 'hive-chameleon-m4-dev' ||
    started.round.protocol_version !== 'm4-v2' ||
    started.round.authority_geometry_version !== 'neon-service-arcade-authority-5' ||
    started.round.authority_geometry_digest !==
      'sha256:0582228533b58772c3496385d088e068f903193dc386aa78af6e9e37b52eccb6'
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
    guestRole.display_name !== 'smoke-user-two' ||
    returningHostRole.round_id !== started.round.id ||
    returningHostRole.role !== 'hider' ||
    returningHostRole.hunter_volunteer !== false ||
    returningHostRole.display_name !== 'smoke-user' ||
    'hiding_slot' in returningHostRole
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
    (state) => state.round_id === started.round.id && state.role === 'hider',
    'private Hider simulation state',
  );
  if (
    guestPlayerState.shells_remaining !== 6 ||
    guestPlayerState.display_name !== 'smoke-user-two' ||
    hiderPlayerState.player_id !== process.env.SMOKE_PLAYER_ID ||
    hiderPlayerState.display_name !== 'smoke-user'
  ) {
    throw new Error('private Casual simulation state was not recipient-correct');
  }
  const initialHunterAvatar = await guestStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.sequence === 1,
    'initial authoritative Hunter spawn',
  );
  const initialHiderAvatar = await returningHostStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_ID &&
      state.sequence === 1,
    'initial authoritative Hider spawn',
  );
  const initialScoreBatch = await guestStates.waitForScores(
    (state) =>
      state.round_id === started.round.id && state.final === false && state.batch_sequence === 1,
    'initial cached provisional score batch',
  );
  if (
    initialScoreBatch.entries.length !== 1 ||
    initialScoreBatch.entries[0].player_id !== process.env.SMOKE_PLAYER_ID ||
    initialScoreBatch.entries[0].display_name !== 'smoke-user' ||
    initialScoreBatch.entries.some((entry) => entry.player_id === process.env.SMOKE_PLAYER_TWO_ID)
  ) {
    throw new Error('scoreboard was not restricted to authoritative Hider entries');
  }

  const paintableRendererIds = [
    'body.abdomen',
    'body.chest',
    'body.head',
    'body.left-ankle-band',
    'body.left-boot',
    'body.left-calf',
    'body.left-elbow',
    'body.left-forearm',
    'body.left-hand',
    'body.left-knee',
    'body.left-shoulder-cap',
    'body.left-thigh',
    'body.left-upper-arm',
    'body.left-wrist-band',
    'body.neck-shell',
    'body.pelvis',
    'body.right-ankle-band',
    'body.right-boot',
    'body.right-calf',
    'body.right-elbow',
    'body.right-forearm',
    'body.right-hand',
    'body.right-knee',
    'body.right-shoulder-cap',
    'body.right-thigh',
    'body.right-upper-arm',
    'body.right-wrist-band',
  ];
  const paintStrokeCount = 40;
  for (let sequence = 1; sequence <= paintStrokeCount; sequence += 1) {
    const points = Array.from({ length: 40 }, (_, index) => ({
      // Unity JsonUtility emits float round-trip decimals. Exercise those larger values so
      // this catches Nakama's 4 KiB WebSocket read limit, not merely runtime validation.
      u: 0.12345678359270096 + index * 0.000001,
      v: 0.8765432238578796 - index * 0.000001,
    }));
    await returningHostSocket.sendMatchState(
      created.match_id,
      16,
      JSON.stringify({
        body_id: 'standard-humanoid-v1',
        channels: 1,
        client_sequence: sequence,
        client_tick: sequence,
        hardness: 1,
        material: {
          base_b: 0.4567891061306,
          base_g: 0.8765432238578796,
          base_r: 0.12345678359270096,
          emission_b: 0.5678911805152893,
          emission_g: 0.7654321193695068,
          emission_intensity: 7.123456001281738,
          emission_r: 0.2345678061246872,
          metallic: 0.3456788957118988,
          roughness: 0.6543219089508057,
        },
        opacity: 0.75,
        points,
        radius: 0.04,
        renderer_id: paintableRendererIds[(sequence - 1) % paintableRendererIds.length],
      }),
    );
    await returningHostStates.waitForPaintSnapshot(
      (stroke) => stroke.round_id === started.round.id && stroke.client_sequence === sequence,
      `paint acknowledgement ${sequence}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 110));
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
    'target_slot_count' in hunting
  ) {
    throw new Error('public Casual hunting state is invalid');
  }

  await guestStates.waitForPaintBatch(
    (batch) =>
      Array.isArray(batch.strokes) &&
      batch.strokes.some(
        (stroke) => stroke.round_id === started.round.id && stroke.sequence === paintStrokeCount,
      ),
    'complete paced paint replay at hunting start',
  );
  const replayedPaintStrokes = guestStates
    .history(19)
    .flatMap((batch) => batch.strokes ?? [])
    .filter((stroke) => stroke.round_id === started.round.id);
  if (
    replayedPaintStrokes.length !== paintStrokeCount ||
    replayedPaintStrokes.some((stroke, index) => stroke.sequence !== index + 1) ||
    new Set(replayedPaintStrokes.map((stroke) => stroke.renderer_id)).size !==
      paintableRendererIds.length
  ) {
    throw new Error('paced paint replay was incomplete, out of order, or omitted body surfaces');
  }

  const smokeHiderAnchor = selectSmokeHiderAnchor(initialHiderAvatar);
  await returningHostSocket.sendMatchState(
    created.match_id,
    14,
    JSON.stringify({
      accent_b: 0.8,
      accent_g: 0.7,
      accent_r: 0.6,
      body_b: 0.4,
      body_g: 0.3,
      body_r: 0.2,
      pitch: 0,
      pose: 'crouching',
      position_x: smokeHiderAnchor.x,
      position_y: smokeHiderAnchor.y,
      position_z: smokeHiderAnchor.z,
      yaw: initialHiderAvatar.yaw,
    }),
  );
  const hiderAvatar = await guestStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_ID &&
      state.role === 'hider' &&
      state.sequence === 2,
    'server-attributed Hider avatar state',
  );
  if (
    hiderAvatar.status !== 'active' ||
    hiderAvatar.sequence !== 2 ||
    hiderAvatar.display_name !== 'smoke-user' ||
    hiderAvatar.position_x !== smokeHiderAnchor.x ||
    hiderAvatar.position_y !== smokeHiderAnchor.y ||
    hiderAvatar.position_z !== smokeHiderAnchor.z ||
    hiderAvatar.pitch !== 0 ||
    hiderAvatar.pose !== 'crouching'
  ) {
    throw new Error('humanoid avatar relay altered or omitted authoritative state');
  }

  returningHostSocket.disconnect(false);
  await reconnectedHiderSocket.connect(session, true, 1_000);
  const reconnect = await waitForReconnectReservation(reconnectedHiderSocket, created.lobby.id);
  if (
    reconnect.match_id !== created.match_id ||
    reconnect.round?.id !== started.round.id ||
    reconnect.reconnect?.round_id !== started.round.id ||
    reconnect.reconnect?.role !== 'hider' ||
    reconnect.reconnect?.outcome_preserved !== true
  ) {
    throw new Error('match.reconnect did not reserve the authoritative Hider state');
  }
  const restoredAvatarPromise = reconnectedHiderStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id && state.player_id === process.env.SMOKE_PLAYER_ID,
    'restored humanoid avatar state',
  );
  await reconnectedHiderSocket.joinMatch(reconnect.match_id);
  const restoredReconnect = await reconnectedHiderStates.waitForReconnect(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_ID &&
      state.status === 'restored',
    'private restored reconnect state',
  );
  const restoredHiderState = await reconnectedHiderStates.waitForPlayerState(
    (state) =>
      state.round_id === started.round.id && state.player_id === process.env.SMOKE_PLAYER_ID,
    'restored authoritative Hider simulation state',
  );
  if (
    !restoredReconnect.outcome_preserved ||
    restoredReconnect.role !== 'hider' ||
    restoredHiderState.role !== 'hider' ||
    restoredHiderState.status !== hiderPlayerState.status
  ) {
    throw new Error('reconnect changed the server-authorized Hider state');
  }
  const restoredAvatar = await restoredAvatarPromise;
  if (
    restoredAvatar.sequence !== hiderAvatar.sequence ||
    restoredAvatar.position_x !== hiderAvatar.position_x ||
    restoredAvatar.pose !== hiderAvatar.pose
  ) {
    throw new Error('reconnect did not restore the latest humanoid avatar snapshot');
  }
  const restoredScoreBatch = await reconnectedHiderStates.waitForScores(
    (state) => state.round_id === started.round.id && state.final === false,
    'restored cached provisional score batch',
  );
  if (
    restoredScoreBatch.batch_sequence !== initialScoreBatch.batch_sequence ||
    restoredScoreBatch.computed_at !== initialScoreBatch.computed_at
  ) {
    throw new Error('reconnect forced an early provisional score refresh');
  }

  const originalMatchId = created.match_id;
  await restartNakama();
  guestSocket.disconnect(false);
  reconnectedHiderSocket.disconnect(false);

  guestSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
  reconnectedHiderSocket = client.createSocket(nakamaUrl.protocol === 'https:', false);
  guestStates = trackMatchStates(guestSocket);
  reconnectedHiderStates = trackMatchStates(reconnectedHiderSocket);
  await guestSocket.connect(secondSession, true, 1_000);
  await reconnectedHiderSocket.connect(session, true, 1_000);

  const recoveredHunter = await waitForReconnectReservation(guestSocket, created.lobby.id);
  const recoveredHider = await waitForReconnectReservation(
    reconnectedHiderSocket,
    created.lobby.id,
  );
  if (
    recoveredHunter.match_id === originalMatchId ||
    recoveredHunter.match_id !== recoveredHider.match_id ||
    recoveredHunter.round?.id !== started.round.id ||
    recoveredHider.round?.id !== started.round.id ||
    recoveredHunter.round?.game_server_build_version !== 'hive-chameleon-m4-dev' ||
    recoveredHider.round?.game_server_build_version !== 'hive-chameleon-m4-dev' ||
    recoveredHunter.round?.protocol_version !== 'm4-v2' ||
    recoveredHider.round?.protocol_version !== 'm4-v2' ||
    recoveredHunter.round?.authority_geometry_digest !== started.round.authority_geometry_digest ||
    recoveredHider.round?.authority_geometry_digest !== started.round.authority_geometry_digest ||
    recoveredHunter.reconnect?.role !== 'hunter' ||
    recoveredHider.reconnect?.role !== 'hider' ||
    !recoveredHunter.reconnect?.outcome_preserved ||
    !recoveredHider.reconnect?.outcome_preserved
  ) {
    throw new Error('Nakama restart did not fence and recover both authoritative roles');
  }
  created.match_id = recoveredHunter.match_id;
  const recoveredAvatarPromise = guestStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id && state.player_id === process.env.SMOKE_PLAYER_ID,
    'post-restart Hider avatar checkpoint',
  );
  await guestSocket.joinMatch(created.match_id);
  await reconnectedHiderSocket.joinMatch(created.match_id);

  const recoveredHunterReconnect = await guestStates.waitForReconnect(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.status === 'restored',
    'post-restart Hunter reconnect outcome',
  );
  const recoveredHiderReconnect = await reconnectedHiderStates.waitForReconnect(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_ID &&
      state.status === 'restored',
    'post-restart Hider reconnect outcome',
  );
  const recoveredHunterRole = await guestStates.waitForRole(
    (assignment) =>
      assignment.round_id === started.round.id &&
      assignment.player_id === process.env.SMOKE_PLAYER_TWO_ID,
    'post-restart Hunter role assignment',
  );
  const recoveredHiderRole = await reconnectedHiderStates.waitForRole(
    (assignment) =>
      assignment.round_id === started.round.id &&
      assignment.player_id === process.env.SMOKE_PLAYER_ID,
    'post-restart Hider role assignment',
  );
  if (
    !recoveredHunterReconnect.outcome_preserved ||
    !recoveredHiderReconnect.outcome_preserved ||
    recoveredHunterRole.role !== guestRole.role ||
    recoveredHiderRole.role !== returningHostRole.role
  ) {
    throw new Error('Nakama restart changed authoritative role or reconnect evidence');
  }

  const recoveredAvatar = await recoveredAvatarPromise;
  if (
    recoveredAvatar.sequence !== hiderAvatar.sequence ||
    recoveredAvatar.position_x !== hiderAvatar.position_x ||
    recoveredAvatar.position_z !== hiderAvatar.position_z ||
    recoveredAvatar.pose !== hiderAvatar.pose
  ) {
    throw new Error('Nakama restart did not rehydrate the accepted avatar snapshot');
  }
  const recoveredScoreBatch = await guestStates.waitForScores(
    (state) =>
      state.round_id === started.round.id &&
      state.final === false &&
      state.batch_sequence === initialScoreBatch.batch_sequence,
    'post-restart cached score batch',
  );
  if (recoveredScoreBatch.computed_at !== initialScoreBatch.computed_at) {
    throw new Error('Nakama restart reset the cached score batch');
  }
  const nextScoreBatch = await guestStates.waitForScores(
    (state) =>
      state.round_id === started.round.id &&
      state.final === false &&
      state.batch_sequence === initialScoreBatch.batch_sequence + 1,
    'post-restart scheduled score cadence',
    35_000,
  );
  if (Date.parse(nextScoreBatch.computed_at) - Date.parse(initialScoreBatch.computed_at) < 29_500) {
    throw new Error('Nakama restart advanced the 30-second score cadence early');
  }

  const hunterAim = aimAvatarAt(initialHunterAvatar, hiderAvatar);
  await guestSocket.sendMatchState(
    created.match_id,
    10,
    JSON.stringify({
      command_id: 'forged-hit',
      hit: true,
      target_player_id: process.env.SMOKE_PLAYER_ID,
    }),
  );
  const forgedHit = await guestStates.waitForFireResult(
    (result) => result.reason === 'invalid_command',
    'client-declared hit rejection',
  );
  if (forgedHit.accepted) {
    throw new Error('authoritative match accepted a client-declared hit');
  }

  await guestSocket.sendMatchState(
    created.match_id,
    14,
    JSON.stringify({
      accent_b: 0.9,
      accent_g: 0.2,
      accent_r: 0.1,
      body_b: 0.25,
      body_g: 0.25,
      body_r: 0.25,
      pitch: hunterAim.pitch,
      pose: 'aiming',
      position_x: initialHunterAvatar.position_x,
      position_y: initialHunterAvatar.position_y,
      position_z: initialHunterAvatar.position_z,
      yaw: hunterAim.yaw,
    }),
  );
  await reconnectedHiderStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.sequence === 2,
    'recent Hunter avatar state',
  );
  await reconnectedHiderSocket.sendMatchState(
    created.match_id,
    14,
    JSON.stringify({
      accent_b: 0.8,
      accent_g: 0.7,
      accent_r: 0.6,
      body_b: 0.4,
      body_g: 0.3,
      body_r: 0.2,
      pitch: 0,
      pose: 'crouching',
      position_x: smokeHiderAnchor.x,
      position_y: smokeHiderAnchor.y,
      position_z: smokeHiderAnchor.z,
      yaw: initialHiderAvatar.yaw,
    }),
  );
  await guestStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_ID &&
      state.sequence === 3,
    'recent Hider avatar state',
  );

  await reconnectedHiderSocket.sendMatchState(
    created.match_id,
    10,
    JSON.stringify({
      command_id: 'hider-forged-shot',
      target_player_id: process.env.SMOKE_PLAYER_ID,
    }),
  );
  const hiderFire = await reconnectedHiderStates.waitForFireResult(
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
      command_id: 'authoritative-hit',
      target_player_id: process.env.SMOKE_PLAYER_ID,
      aim_yaw: hunterAim.yaw,
      aim_pitch: hunterAim.pitch,
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
  const answerCheck = await guestStates.waitForRound(
    (round) => round.id === started.round.id && round.status === 'answer_check',
    'Casual Answer Check',
  );
  if (
    !authoritativeHit.accepted ||
    !authoritativeHit.hit ||
    authoritativeHit.hider_player_id !== process.env.SMOKE_PLAYER_ID ||
    discovery.hider_player_id !== process.env.SMOKE_PLAYER_ID ||
    'aim_slot' in authoritativeHit ||
    'aim_slot' in discovery ||
    answerCheck.winning_side !== 'hunters' ||
    answerCheck.completion_reason !== 'all_hiders_found' ||
    answerCheck.hiders_remaining !== 0
  ) {
    throw new Error('Casual round did not resolve an authoritative Hunter win');
  }
  const answerCheckHunter = await guestStates.waitForSpectator(
    (state) =>
      state.round_id === started.round.id &&
      state.phase === 'answer_check' &&
      state.eligible === false,
    'original Hunter Answer Check control state',
  );
  if (
    answerCheckHunter.reason !== 'answer_check_hunter' ||
    answerCheckHunter.players.length !== 0
  ) {
    throw new Error('original Hunter was forced into spectator mode during Answer Check');
  }
  const answerCheckHider = await reconnectedHiderStates.waitForSpectator(
    (state) =>
      state.round_id === started.round.id &&
      state.phase === 'answer_check' &&
      state.eligible === true,
    'original Hider Answer Check spectator state',
  );
  if (
    answerCheckHider.reason !== 'answer_check_hider' ||
    answerCheckHider.players.length !== 2 ||
    answerCheckHider.visible_player_name_ids.length !== 2 ||
    !answerCheckHider.players.some(
      (player) =>
        player.player_id === process.env.SMOKE_PLAYER_ID && player.display_name === 'smoke-user',
    )
  ) {
    throw new Error('original Hider did not receive full Answer Check spectator state');
  }
  await guestSocket.sendMatchState(
    created.match_id,
    14,
    JSON.stringify({
      accent_b: 0.9,
      accent_g: 0.2,
      accent_r: 0.1,
      body_b: 0.25,
      body_g: 0.25,
      body_r: 0.25,
      pitch: hunterAim.pitch,
      pose: 'running',
      position_x: initialHunterAvatar.position_x,
      position_y: initialHunterAvatar.position_y,
      position_z: initialHunterAvatar.position_z,
      yaw: hunterAim.yaw,
    }),
  );
  const movingAnswerCheckHunter = await reconnectedHiderStates.waitForAvatar(
    (state) =>
      state.round_id === started.round.id &&
      state.player_id === process.env.SMOKE_PLAYER_TWO_ID &&
      state.sequence === 3,
    'moving original Hunter during Answer Check',
  );
  if (
    movingAnswerCheckHunter.role !== 'hunter' ||
    movingAnswerCheckHunter.status !== 'active' ||
    movingAnswerCheckHunter.position_x !== initialHunterAvatar.position_x ||
    movingAnswerCheckHunter.pitch !== hunterAim.pitch
  ) {
    throw new Error('Answer Check did not relay the controllable original Hunter');
  }
  const reveal = await guestStates.waitForAnswerCheck(
    (state) => state.round_id === started.round.id && state.reveals.length === 1,
    'Answer Check reveal',
  );
  if (
    reveal.reveals[0].player_id !== process.env.SMOKE_PLAYER_ID ||
    reveal.reveals[0].display_name !== 'smoke-user' ||
    reveal.reveals[0].role !== 'hider' ||
    reveal.reveals[0].status !== 'found' ||
    reveal.reveals[0].avatar_state_available !== true ||
    reveal.reveals[0].position_x !== hiderAvatar.position_x ||
    reveal.reveals[0].pose !== hiderAvatar.pose ||
    'slot' in reveal.reveals[0]
  ) {
    throw new Error('Answer Check did not reveal the authoritative Hider');
  }
  await guestSocket.sendMatchState(
    created.match_id,
    11,
    JSON.stringify({
      command_id: 'favorite-disguise',
      target_hider_player_id: process.env.SMOKE_PLAYER_ID,
    }),
  );
  const like = await guestStates.waitForLikeResult(
    (state) => state.command_id === 'favorite-disguise',
    'accepted Answer Check like',
  );
  if (!like.accepted || like.reason !== 'accepted') {
    throw new Error('eligible Answer Check like was rejected');
  }
  await guestStates.waitForScores(
    (state) =>
      state.round_id === started.round.id &&
      state.final === true &&
      state.entries.some(
        (entry) =>
          entry.player_id === process.env.SMOKE_PLAYER_ID && entry.breakdown.disguise_likes === 100,
      ),
    'like-adjusted authoritative score',
  );
  const completedRound = await guestStates.waitForRound(
    (round) => round.id === started.round.id && round.status === 'completed',
    'durably completed Casual round',
    30_000,
  );
  if (!completedRound.result_revision_id) {
    throw new Error('completed round omitted its durable result revision ID');
  }

  reconnectedHiderSocket.disconnect(false);
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
      casualRound: 'completed_hunter_win',
      answerCheck: 'revealed_liked_scored',
      reconnect: 'restored_authoritative_hider_within_60_seconds',
      nakamaRestartRecovery: 'roles_avatar_reconnect_score_cadence_rehydrated',
      avatarState: 'server_attributed_and_restored',
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
  reconnectedHiderSocket.disconnect(false);
}

function selectSmokeHiderAnchor(initialAvatar) {
  // Mirrors the first Hider spawn in runtime/nakama/arena_catalog.go. Spawns move
  // whenever the authority geometry changes, because they have to stand on floor
  // the server considers clear.
  const spawns = [[-9, -1, -9, -1]];
  const match = spawns.find(
    ([spawnX, spawnZ]) =>
      Math.abs(initialAvatar.position_x - spawnX) < 0.001 &&
      Math.abs(initialAvatar.position_z - spawnZ) < 0.001,
  );
  if (!match) {
    throw new Error('authoritative Hider did not use the deterministic smoke spawn');
  }
  return { x: match[2], y: 0.05, z: match[3] };
}

function aimAvatarAt(hunter, target) {
  const horizontalX = target.position_x - hunter.position_x;
  const horizontalZ = target.position_z - hunter.position_z;
  const horizontalDistance = Math.hypot(horizontalX, horizontalZ);
  const verticalDistance = target.position_y + 0.95 - (hunter.position_y + 1.62);
  const yaw = ((Math.atan2(horizontalX, horizontalZ) * 180) / Math.PI + 360) % 360;
  const pitch = (-Math.atan2(verticalDistance, horizontalDistance) * 180) / Math.PI;
  return { pitch, yaw };
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

async function waitForReconnectReservation(socket, lobbyId) {
  const deadline = Date.now() + 5_000;
  let latestError;
  while (Date.now() < deadline) {
    try {
      return await lobbyRpc(socket, 'match.reconnect', { lobby_id: lobbyId });
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw latestError ?? new Error('Timed out waiting for reconnect reservation');
}

async function restartNakama() {
  const containerId = process.env.SMOKE_NAKAMA_CONTAINER_ID;
  if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
    throw new Error('Nakama restart requires a validated container ID');
  }
  await execFileAsync('docker', ['restart', '--time', '10', containerId], {
    timeout: 30_000,
  });
  const deadline = Date.now() + 30_000;
  let latestError;
  while (Date.now() < deadline) {
    try {
      await client.getAccount(session);
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw latestError ?? new Error('Nakama did not recover after process restart');
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
  const historyByOpcode = new Map();
  const waiters = new Map([
    [1, new Set()],
    [2, new Set()],
    [3, new Set()],
    [4, new Set()],
    [5, new Set()],
    [6, new Set()],
    [7, new Set()],
    [8, new Set()],
    [9, new Set()],
    [12, new Set()],
    [13, new Set()],
    [15, new Set()],
    [17, new Set()],
    [18, new Set()],
    [19, new Set()],
  ]);
  socket.onmatchdata = (message) => {
    const opcode = Number(message.op_code);
    const opcodeWaiters = waiters.get(opcode);
    if (!opcodeWaiters) {
      return;
    }
    const state = JSON.parse(new TextDecoder().decode(message.data));
    const history = historyByOpcode.get(opcode) ?? [];
    history.push(state);
    if (history.length > 32) {
      history.shift();
    }
    historyByOpcode.set(opcode, history);
    for (const waiter of opcodeWaiters) {
      if (waiter.predicate(state)) {
        clearTimeout(waiter.timeout);
        opcodeWaiters.delete(waiter);
        waiter.resolve(state);
      }
    }
  };
  function waitFor(opcode, predicate, description, timeoutMs = 10_000) {
    const history = historyByOpcode.get(opcode) ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const current = history[index];
      if (predicate(current)) {
        return Promise.resolve(current);
      }
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
    waitForSpectator: (predicate, description) => waitFor(7, predicate, description),
    waitForScores: (predicate, description, timeoutMs) =>
      waitFor(8, predicate, description, timeoutMs),
    waitForAnswerCheck: (predicate, description) => waitFor(9, predicate, description),
    waitForLikeResult: (predicate, description) => waitFor(12, predicate, description),
    waitForReconnect: (predicate, description) => waitFor(13, predicate, description),
    waitForAvatar: (predicate, description) => waitFor(15, predicate, description),
    waitForPaintSnapshot: (predicate, description) => waitFor(17, predicate, description),
    waitForPaintResult: (predicate, description) => waitFor(18, predicate, description),
    waitForPaintBatch: (predicate, description) => waitFor(19, predicate, description),
    history: (opcode) => [...(historyByOpcode.get(opcode) ?? [])],
  };
}
