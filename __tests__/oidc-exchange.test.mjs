// Committed coverage for the OIDC-exchange replay-vs-retry hardening in sync.mjs (exchangeOidcWithRetry).
//
// The server enforces one-time use per OIDC jti (replay guard → 409). The fix: each retry attempt re-fetches a
// FRESH OIDC token (a new jti), so a transient blip (5xx / network / lost response) is retried with a distinct
// token and can NEVER be refused as a replay. A terminal 401/403 is returned immediately (not retried).
//
// Uses Node's built-in test runner (`node --test`) — zero new deps, matching sync.mjs's ethos. sync.mjs guards
// main() behind an entrypoint check, so importing the helper is side-effect-free.
//
// Run:  node --test __tests__/oidc-exchange.test.mjs   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exchangeOidcWithRetry } from '../sync.mjs';

const jsonRes = (status, body = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

/** Install a stub global.fetch, returning it plus a record of every request body seen. Restores on dispose. */
function withStubFetch(handler) {
  const original = global.fetch;
  const bodies = [];
  global.fetch = async (_url, opts) => {
    const parsed = opts?.body ? JSON.parse(opts.body) : undefined;
    bodies.push(parsed);
    return handler(bodies.length, parsed);
  };
  return { bodies, restore: () => { global.fetch = original; } };
}

test('a transient 5xx is retried with a FRESH token per attempt, then succeeds (no replayed jti)', async () => {
  // fetchIdToken hands out a NEW jti-bearing token each call; assert every exchange attempt used a distinct one.
  let minted = 0;
  const fetchIdToken = async () => `jwt-${++minted}`;

  const stub = withStubFetch((n) => (n === 1 ? jsonRes(503) : jsonRes(200, { token: 'dep_ok' })));
  try {
    const res = await exchangeOidcWithRetry(fetchIdToken, 'https://x/token', { retries: 3, timeoutMs: 100 });
    assert.equal(res.status, 200);
    // TWO attempts were made, and each carried a DIFFERENT token (fresh jti) — the retried exchange did not reuse
    // the stale token, so the server's replay guard can never trip.
    assert.equal(stub.bodies.length, 2);
    assert.equal(stub.bodies[0].token, 'jwt-1');
    assert.equal(stub.bodies[1].token, 'jwt-2');
    assert.notEqual(stub.bodies[0].token, stub.bodies[1].token);
    assert.equal(minted, 2);
  } finally {
    stub.restore();
  }
});

test('a network error (lost response) is retried with a fresh token and succeeds', async () => {
  let minted = 0;
  const fetchIdToken = async () => `jwt-${++minted}`;

  const original = global.fetch;
  let call = 0;
  const bodies = [];
  global.fetch = async (_url, opts) => {
    call++;
    bodies.push(JSON.parse(opts.body));
    if (call === 1) throw new Error('socket hang up'); // lost response / transient network
    return jsonRes(200, { token: 'dep_ok' });
  };
  try {
    const res = await exchangeOidcWithRetry(fetchIdToken, 'https://x/token', { retries: 3, timeoutMs: 100 });
    assert.equal(res.status, 200);
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0].token, bodies[1].token); // distinct jti per attempt
  } finally {
    global.fetch = original;
  }
});

test('a terminal 403 (unbound repo) is returned immediately — NOT retried', async () => {
  let minted = 0;
  const fetchIdToken = async () => `jwt-${++minted}`;

  const stub = withStubFetch(() => jsonRes(403, { error: 'unbound' }));
  try {
    const res = await exchangeOidcWithRetry(fetchIdToken, 'https://x/token', { retries: 3, timeoutMs: 100 });
    assert.equal(res.status, 403);
    // Exactly ONE attempt — a 403 is terminal, so we do not burn retries (or mint extra tokens).
    assert.equal(stub.bodies.length, 1);
    assert.equal(minted, 1);
  } finally {
    stub.restore();
  }
});

test('a terminal 401 (invalid token) is returned immediately — NOT retried', async () => {
  let minted = 0;
  const fetchIdToken = async () => `jwt-${++minted}`;

  const stub = withStubFetch(() => jsonRes(401, { error: 'invalid' }));
  try {
    const res = await exchangeOidcWithRetry(fetchIdToken, 'https://x/token', { retries: 3, timeoutMs: 100 });
    assert.equal(res.status, 401);
    assert.equal(stub.bodies.length, 1);
    assert.equal(minted, 1);
  } finally {
    stub.restore();
  }
});
