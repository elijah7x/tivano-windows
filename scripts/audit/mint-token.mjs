// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import crypto from 'node:crypto';
import fs from 'node:fs';

function fail(message) {
  const safe = String(message || 'Unknown error')
    .replace(/-----BEGIN[\s\S]*?-----END[^\r\n]*/g, '<redacted-key>')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 240);
  process.stderr.write(`mint-token: ${safe}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { appId: '', installationId: '', keyPath: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app-id' || arg.startsWith('--app-id=')) {
      out.appId = arg.includes('=') ? arg.slice('--app-id='.length) : (argv[++i] ?? '');
    } else if (arg === '--installation-id' || arg.startsWith('--installation-id=')) {
      out.installationId = arg.includes('=')
        ? arg.slice('--installation-id='.length)
        : (argv[++i] ?? '');
    } else if (arg === '--key' || arg.startsWith('--key=')) {
      out.keyPath = arg.includes('=') ? arg.slice('--key='.length) : (argv[++i] ?? '');
    } else {
      fail(`Unsupported argument: ${arg}`);
    }
  }
  if (!out.appId || !/^[A-Za-z0-9._-]+$/.test(out.appId)) {
    fail('Missing or invalid --app-id.');
  }
  if (!out.installationId || !/^[0-9]+$/.test(out.installationId)) {
    fail('Missing or invalid --installation-id.');
  }
  if (!out.keyPath) {
    fail('Missing --key <pem>.');
  }
  return out;
}

function buildJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: String(appId),
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKeyPem)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

async function main() {
  const { appId, installationId, keyPath } = parseArgs(process.argv.slice(2));

  let pem;
  try {
    pem = fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    fail(`Could not read private key file (${err?.code || 'read error'}).`);
  }
  if (!pem || !pem.includes('PRIVATE KEY')) {
    fail('Private key file does not appear to contain a PEM private key.');
  }

  let jwt;
  try {
    jwt = buildJwt(appId, pem);
  } catch (err) {
    fail(`Failed to sign RS256 JWT (${err?.code || err?.message || 'crypto error'}).`);
  }

  const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tivano-windows-audit',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    fail(`GitHub API request failed (${err?.name || 'network error'}).`);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const apiMsg = typeof data?.message === 'string' ? data.message : response.statusText || 'request failed';
    fail(`GitHub API returned HTTP ${response.status}: ${apiMsg}`);
  }

  if (!data || typeof data.token !== 'string' || data.token.length === 0) {
    fail('GitHub API response did not include an installation access token.');
  }

  process.stdout.write(`${data.token}\n`);
}

main().catch((err) => {
  fail(err?.message || 'Unexpected error.');
});
