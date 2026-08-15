(() => {
  'use strict';

  const refreshStorageKey = 'hive-chameleon.web-session.v1';

  async function requestJson(path, body) {
    const response = await fetch(new URL(path, window.location.origin), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Session request failed with HTTP ${response.status}.`);
    }
    return response.json();
  }

  function readRefreshToken() {
    try {
      return window.localStorage.getItem(refreshStorageKey) ?? '';
    } catch {
      return '';
    }
  }

  function writeRefreshToken(value) {
    try {
      if (value) {
        window.localStorage.setItem(refreshStorageKey, value);
      } else {
        window.localStorage.removeItem(refreshStorageKey);
      }
    } catch {
      // Storage can be unavailable in hardened/private browsing. The current
      // tab still receives an isolated session; only refresh persistence is lost.
    }
  }

  async function acquireBrowserSession() {
    const refreshToken = readRefreshToken();
    if (refreshToken) {
      try {
        const refreshed = await requestJson('/api/v1/auth/refresh', { refreshToken });
        writeRefreshToken(refreshed.refreshToken);
        return refreshed;
      } catch {
        writeRefreshToken('');
      }
    }

    const created = await requestJson('/api/v1/auth/guest', {});
    writeRefreshToken(created.refreshToken);
    return created;
  }

  window.hiveChameleonReady = Promise.all([
    fetch('runtime-config.json', { cache: 'no-store', credentials: 'omit' }).then((response) => {
      if (!response.ok) {
        throw new Error(`Runtime configuration failed with HTTP ${response.status}.`);
      }
      return response.json();
    }),
    acquireBrowserSession(),
  ]).then(([configuration, session]) => {
    if (
      typeof configuration.apiBaseUrl !== 'string' ||
      typeof configuration.nakamaServerKey !== 'string' ||
      typeof session.accessToken !== 'string'
    ) {
      throw new Error('The public game session response is incomplete.');
    }
    return [
      '--hc-authoritative-runtime',
      `--hc-api-base-url=${configuration.apiBaseUrl}`,
      `--hc-nakama-server-key=${configuration.nakamaServerKey}`,
      `--hc-bearer-token=${session.accessToken}`,
      '--hc-client-slot=0',
    ];
  });
})();
