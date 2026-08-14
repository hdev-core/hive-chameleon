import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = resolve(import.meta.dirname, '..');

test('prepares a credential-neutral Unity build for one public origin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-chameleon-public-webgl-'));
  try {
    writeFileSync(
      join(directory, 'index.html'),
      `<html><head>  </head><body><script>
const config = { arguments: [], };
      document.body.appendChild(script);
</script></body></html>`,
    );
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'scripts/prepare-public-webgl.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HIVE_CHAMELEON_PUBLIC_ORIGIN: 'https://game.example.test',
          HIVE_CHAMELEON_WEBGL_BUILD_PATH: directory,
          NAKAMA_SERVER_KEY: 'public-client-key',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const index = readFileSync(join(directory, 'index.html'), 'utf8');
    assert.match(index, /game-bootstrap\.js/);
    assert.match(index, /window\.hiveChameleonReady/);
    assert.match(index, /config\.arguments = runtimeArguments/);
    assert.doesNotMatch(index, /bearer|refreshToken/i);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'runtime-config.json'), 'utf8')), {
      apiBaseUrl: 'https://game.example.test',
      nakamaServerKey: 'public-client-key',
    });
    assert.equal(
      readFileSync(join(directory, 'game-bootstrap.js'), 'utf8'),
      readFileSync(join(repositoryRoot, 'scripts/public-webgl-bootstrap.js'), 'utf8'),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('creates one guest session and passes only its access token into Unity', async () => {
  const stored = new Map();
  const requests = [];
  const context = browserContext(stored, requests, {
    '/api/v1/auth/guest': {
      accessToken: 'isolated-access-token',
      refreshToken: 'isolated-refresh-token',
    },
    'runtime-config.json': {
      apiBaseUrl: 'https://game.example.test',
      nakamaServerKey: 'public-client-key',
    },
  });

  runBootstrap(context);
  assert.deepEqual(
    [...(await context.window.hiveChameleonReady)],
    [
      '--hc-authoritative-runtime',
      '--hc-api-base-url=https://game.example.test',
      '--hc-nakama-server-key=public-client-key',
      '--hc-bearer-token=isolated-access-token',
      '--hc-client-slot=0',
    ],
  );
  assert.equal(stored.get('hive-chameleon.web-session.v1'), 'isolated-refresh-token');
  assert.deepEqual(
    requests.map(({ url }) => url),
    ['runtime-config.json', 'https://game.example.test/api/v1/auth/guest'],
  );
});

test('rotates an existing browser refresh credential instead of creating another player', async () => {
  const stored = new Map([['hive-chameleon.web-session.v1', 'previous-refresh-token']]);
  const requests = [];
  const context = browserContext(stored, requests, {
    '/api/v1/auth/refresh': {
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    },
    'runtime-config.json': {
      apiBaseUrl: 'https://game.example.test',
      nakamaServerKey: 'public-client-key',
    },
  });

  runBootstrap(context);
  const arguments_ = await context.window.hiveChameleonReady;
  assert.ok(arguments_.includes('--hc-bearer-token=rotated-access-token'));
  assert.equal(stored.get('hive-chameleon.web-session.v1'), 'rotated-refresh-token');
  assert.equal(
    requests.some(({ url }) => url.endsWith('/auth/guest')),
    false,
  );
  assert.deepEqual(
    JSON.parse(requests.find(({ url }) => url.endsWith('/auth/refresh')).options.body),
    {
      refreshToken: 'previous-refresh-token',
    },
  );
});

function runBootstrap(context) {
  vm.runInNewContext(
    readFileSync(join(repositoryRoot, 'scripts/public-webgl-bootstrap.js'), 'utf8'),
    context,
  );
}

function browserContext(stored, requests, responses) {
  const origin = 'https://game.example.test';
  const window = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      removeItem: (key) => stored.delete(key),
      setItem: (key, value) => stored.set(key, value),
    },
    location: { origin },
  };
  return {
    Error,
    JSON,
    Promise,
    URL,
    fetch: async (input, options = {}) => {
      const url = String(input);
      requests.push({ options, url });
      const key = url.startsWith(origin) ? new URL(url).pathname : url;
      const body = responses[key];
      return {
        json: async () => body,
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
      };
    },
    window,
  };
}
