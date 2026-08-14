import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildPath = resolve(
  process.env.HIVE_CHAMELEON_WEBGL_BUILD_PATH ?? join(repositoryRoot, 'clients/unity/Builds/WebGL'),
);
const publicOrigin = canonicalPublicOrigin(process.env.HIVE_CHAMELEON_PUBLIC_ORIGIN);
const nakamaServerKey = required(process.env.NAKAMA_SERVER_KEY, 'NAKAMA_SERVER_KEY');
const indexPath = join(buildPath, 'index.html');
const original = readFileSync(indexPath, 'utf8');

if (!original.includes('arguments: [],')) {
  throw new Error('The WebGL build does not expose an empty credential-neutral argument list.');
}
if (!original.includes('document.body.appendChild(script);')) {
  throw new Error('The WebGL template launch point could not be located.');
}

const bootstrapTag = '    <script src="game-bootstrap.js"></script>\n';
let prepared = original.replace('  </head>', `${bootstrapTag}  </head>`);
prepared = prepared.replace(
  '      document.body.appendChild(script);',
  `      window.hiveChameleonReady\n` +
    `        .then((runtimeArguments) => {\n` +
    `          config.arguments = runtimeArguments;\n` +
    `          document.body.appendChild(script);\n` +
    `        })\n` +
    `        .catch((error) => {\n` +
    `          unityShowBanner(error instanceof Error ? error.message : String(error), 'error');\n` +
    `          document.querySelector('#unity-loading-bar').style.display = 'none';\n` +
    `        });`,
);

writeFileSync(indexPath, prepared);
copyFileSync(
  join(repositoryRoot, 'scripts/public-webgl-bootstrap.js'),
  join(buildPath, 'game-bootstrap.js'),
);
writeFileSync(
  join(buildPath, 'runtime-config.json'),
  `${JSON.stringify({ apiBaseUrl: publicOrigin, nakamaServerKey })}\n`,
  { mode: 0o644 },
);

console.log(`Public WebGL artifact prepared for ${publicOrigin}/game/.`);

function canonicalPublicOrigin(value) {
  const supplied = required(value, 'HIVE_CHAMELEON_PUBLIC_ORIGIN');
  const parsed = new URL(supplied);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== supplied
  ) {
    throw new Error('HIVE_CHAMELEON_PUBLIC_ORIGIN must be a canonical HTTPS origin.');
  }
  return parsed.origin;
}

function required(value, name) {
  const resolved = value?.trim();
  if (!resolved) {
    throw new Error(`${name} is required.`);
  }
  return resolved;
}
