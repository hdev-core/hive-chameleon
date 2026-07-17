import { createHmac, randomBytes } from 'node:crypto';

import { Client, Session } from '@heroiclabs/nakama-js';

const requiredEnvironment = [
  'NAKAMA_SERVER_KEY',
  'NAKAMA_BRIDGE_HMAC_KEY',
  'REALTIME_DEV_AUTH_SESSION_ID',
  'REALTIME_DEV_BEARER_TOKEN',
  'REALTIME_DEV_PLAYER_ID',
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
    app_auth_session_id: process.env.REALTIME_DEV_AUTH_SESSION_ID,
    app_player_id: process.env.REALTIME_DEV_PLAYER_ID,
    bridge_version: 'v1',
  });
} catch {
  deviceAuthenticationRejected = true;
}

if (!deviceAuthenticationRejected) {
  throw new Error('Nakama accepted a non-bridge device authentication attempt');
}

const replayAssertion = createBridgeAssertion({
  authSessionId: process.env.REALTIME_DEV_AUTH_SESSION_ID,
  bridgeKey: process.env.NAKAMA_BRIDGE_HMAC_KEY,
  playerId: process.env.REALTIME_DEV_PLAYER_ID,
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
  await client.linkCustom(directBridgeSession, { id: process.env.REALTIME_DEV_AUTH_SESSION_ID });
} catch {
  customIdentityPreclaimRejected = true;
}
if (!customIdentityPreclaimRejected) {
  throw new Error('Nakama allowed a bridged user to preclaim another custom identity');
}

const response = await fetch(apiUrl, {
  headers: {
    authorization: `Bearer ${process.env.REALTIME_DEV_BEARER_TOKEN}`,
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
const socket = client.createSocket(nakamaUrl.protocol === 'https:', false);
let rpcError;
try {
  await socket.connect(session, true, 1_000);
  try {
    await socket.rpc('lobby.create', '{}');
  } catch (error) {
    rpcError = error;
  }
} finally {
  socket.disconnect(false);
}

// Nakama's realtime protocol represents an RPC runtime exception with code 7. The message
// preserves the stub's feature_not_ready contract; HTTP RPC callers receive gRPC UNIMPLEMENTED.
if (rpcError?.code !== 7 || rpcError?.message !== 'feature_not_ready') {
  throw new Error(
    `Expected feature_not_ready realtime RPC error, received ${String(rpcError?.code)}:${String(rpcError?.message)}`,
  );
}

console.log(
  JSON.stringify({
    bridgeSessionConnected: true,
    bridgeAssertionReplayRejected,
    customIdentityPreclaimRejected,
    deviceAuthenticationRejected,
    reservedRpc: 'feature_not_ready',
  }),
);

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

function compactUuid(value) {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('Bridge smoke identity must be a canonical lowercase UUID');
  }
  return Buffer.from(hex, 'hex').toString('base64url');
}
