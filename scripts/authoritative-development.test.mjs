import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clientPlayerId,
  developmentClientProvisioningSql,
  parseClientCount,
  patchWebGlIndex,
} from './authoritative-development.mjs';

test('client counts are bounded to the supported lobby size', () => {
  assert.equal(parseClientCount(undefined, 2), 2);
  assert.equal(parseClientCount('1'), 1);
  assert.equal(parseClientCount('10'), 10);
  assert.throws(() => parseClientCount('0'), /between 1 and 10/);
  assert.throws(() => parseClientCount('11'), /between 1 and 10/);
  assert.throws(() => parseClientCount('two'), /between 1 and 10/);
});

test('development player IDs are stable canonical UUIDv7 values', () => {
  assert.equal(clientPlayerId(1), '01920000-0000-7000-8000-000000000001');
  assert.equal(clientPlayerId(10), '01920000-0000-7000-8000-00000000000a');
  assert.match(
    clientPlayerId(7),
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('client provisioning atomically supersedes a stale open session', () => {
  const updatePosition = developmentClientProvisioningSql.indexOf('UPDATE identity.auth_session');
  const insertPosition = developmentClientProvisioningSql.indexOf(
    'INSERT INTO identity.auth_session',
  );

  assert.match(developmentClientProvisioningSql, /^\s*BEGIN;/);
  assert.ok(updatePosition > -1);
  assert.ok(insertPosition > updatePosition);
  assert.match(developmentClientProvisioningSql, /AND revoked_at IS NULL/);
  assert.match(developmentClientProvisioningSql, /AND id <> :'session_id'/);
  assert.match(developmentClientProvisioningSql, /COMMIT;\s*$/);
});

test('the WebGL launcher injects per-client arguments into one Unity build', () => {
  const source = '<script>var config = { arguments: [], dataUrl: "Build/WebGL.data" };</script>';
  const output = patchWebGlIndex(source, ['--hc-authoritative-development', '--hc-client-slot=3']);
  assert.match(output, /"--hc-authoritative-development"/);
  assert.match(output, /"--hc-client-slot=3"/);
  assert.doesNotMatch(output, /arguments:\s*\[\s*\]/);
});

test('the WebGL launcher fails closed when Unity changes its template contract', () => {
  assert.throws(
    () => patchWebGlIndex('<html>no arguments field</html>', []),
    /expected config\.arguments field/,
  );
});
