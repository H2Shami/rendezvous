import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { OwnerService, OWNER_SESSION_MS } from '../src/owners/service.js';
import { ownerAuthConfig, type IdentityProvider, type LoginChecks } from '../src/owners/provider.js';
import { secret, uuid } from '../src/validation.js';

const origin = 'https://app.example';
function fakeProvider() {
  let checks: LoginChecks;
  const provider: IdentityProvider = {
    async authorize(c) { checks = { state: c.state, verifier: c.verifier, nonce: c.nonce }; return `https://login.example/authorize?state=${c.state}`; },
    async exchange(url, c) {
      assert.deepEqual(c, checks);
      assert.equal(url.origin, origin);
      if (url.searchParams.get('code') !== 'valid') throw new Error('PRIVATE_TOKEN_AND_CODE');
      return { issuer: 'https://issuer.example', subject: 'user-1' };
    },
    logoutUrl: () => 'https://login.example/logout',
  };
  return provider;
}

test('owner sessions are durable, expire absolutely, rotate, revoke and enforce principal ownership', async () => {
  const f = await fixture();
  const owners = new OwnerService(f.db, f.auth, f.now);
  const issuer = `https://${uuid()}.example`;
  const ids: string[] = [];
  try {
    const a = await owners.establish(issuer, 'a'); ids.push(a.ownerId);
    const b = await owners.establish(issuer, 'b'); ids.push(b.ownerId);
    assert.notEqual(a.ownerId, b.ownerId);
    const principal = await new OwnerService(f.db, f.auth, f.now).authenticate(a.token);
    owners.requireOwnership(principal, a.ownerId);
    assert.throws(() => owners.requireOwnership(principal, b.ownerId), { code: 'NOT_FOUND' });
    const hashes = await f.db.query<{ token_hash: string }>('SELECT token_hash FROM owner_sessions WHERE owner_id=$1', [a.ownerId]);
    assert.notEqual(hashes.rows[0].token_hash, a.token);
    const rotated = await owners.establish(issuer, 'a', a.token);
    assert.equal(rotated.ownerId, a.ownerId);
    await assert.rejects(owners.authenticate(a.token), { code: 'OWNER_UNAUTHORIZED' });
    assert.throws(() => owners.checkCsrf(rotated.token, owners.csrf(b.token)), { code: 'CSRF_INVALID' });
    owners.checkCsrf(rotated.token, owners.csrf(rotated.token));
    await owners.revoke(b.token);
    await assert.rejects(owners.authenticate(b.token), { code: 'OWNER_UNAUTHORIZED' });
    f.advance(OWNER_SESSION_MS);
    await assert.rejects(owners.authenticate(rotated.token), { code: 'OWNER_UNAUTHORIZED' });
    const disabled = await owners.establish(issuer, 'a');
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1', [a.ownerId]);
    await assert.rejects(owners.authenticate(disabled.token), { code: 'OWNER_UNAUTHORIZED' });
    await assert.rejects(owners.establish(issuer, 'a'), { code: 'OWNER_DISABLED' });
  } finally {
    for (const id of ids) await f.db.query('DELETE FROM owners WHERE id=$1', [id]);
    await f.stop();
  }
});

test('login attempts are browser-bound, expire, and can be consumed only once under concurrency', async () => {
  const f = await fixture(); const owners = new OwnerService(f.db, f.auth, f.now);
  try {
    const attempt = await owners.beginLogin();
    await assert.rejects(owners.consumeLogin(attempt.state, secret()), { code: 'LOGIN_INVALID' });
    const results = await Promise.allSettled([owners.consumeLogin(attempt.state, attempt.browser), owners.consumeLogin(attempt.state, attempt.browser)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const expired = await owners.beginLogin(); f.advance(600_000);
    await assert.rejects(owners.consumeLogin(expired.state, expired.browser), { code: 'LOGIN_INVALID' });
    await owners.cleanup();
  } finally { await f.stop(); }
});

test('browser login/callback/logout use separate secure cookies, CSRF and sanitized errors', async () => {
  const logs: unknown[] = [];
  const f = await fixture({ publicUrl: origin, ownerProvider: fakeProvider(), logger: e => logs.push(e) });
  const call = (path: string, init: RequestInit = {}) => fetch(`${f.base}/api/v1/owner/${path}`, { ...init, redirect: 'manual' });
  let ownerId: string | undefined;
  try {
    assert.equal((await call('me')).status, 401);
    const room = await f.create();
    assert.equal((await call('me', { headers: { Authorization: `Bearer ${room.owner_token}` } })).status, 401);
    assert.equal((await call('me', { headers: { Cookie: `__Host-rv-owner=${room.owner_token}` } })).status, 401);
    assert.equal((await call('me', { headers: { Authorization: `Bearer agk_${uuid()}.${secret()}` } })).status, 401);
    const login = await call('login'); assert.equal(login.status, 303);
    const cookie = login.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/);
    const browser = cookie.split(';')[0];
    const state = new URL(login.headers.get('location')!).searchParams.get('state');
    const callback = `callback?state=${state}&code=valid`;
    assert.match((await call(callback)).headers.get('location')!, /sign_in_failed/);
    const completed = await call(callback, { headers: { Cookie: browser, Host: 'evil.example' } });
    assert.equal(completed.headers.get('location'), `${origin}/account`);
    assert.equal(completed.headers.getSetCookie().length, 2);
    const authCookie = completed.headers.getSetCookie().find(c => c.startsWith('__Host-rv-owner='))!.split(';')[0];
    const me = await (await call('me', { headers: { Cookie: authCookie } })).json();
    ownerId = me.owner.id;
    assert.match(me.csrf_token, /^[a-f0-9]{64}$/);
    assert.equal((await call('me', { headers: { Cookie: `${authCookie}; ${authCookie}` } })).status, 401);
    assert.match((await call(callback, { headers: { Cookie: browser } })).headers.get('location')!, /sign_in_failed/);
    assert.equal((await call('logout', { method: 'POST', headers: { Cookie: authCookie } })).status, 403);
    assert.equal((await call('logout', { method: 'POST', headers: { Cookie: authCookie, Origin: origin } })).status, 403);
    assert.equal((await call('logout', { method: 'POST', headers: { Cookie: authCookie, Origin: 'https://evil.example', 'X-CSRF-Token': me.csrf_token } })).status, 403);
    const logout = await call('logout', { method: 'POST', headers: { Cookie: authCookie, Origin: origin, 'X-CSRF-Token': me.csrf_token } });
    assert.equal(logout.status, 200); assert.equal((await logout.json()).logout_url, 'https://login.example/logout');
    assert.equal((await call('me', { headers: { Cookie: authCookie } })).status, 401);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${state}|PRIVATE_TOKEN_AND_CODE|csrf_token|code=valid`));
  } finally {
    if (ownerId) await f.db.query('DELETE FROM owners WHERE id=$1', [ownerId]);
    await f.stop();
  }
});

test('owner auth is explicitly configured and rejects unsafe origins/provider URLs', async () => {
  assert.equal(ownerAuthConfig({}, 'https://app.example'), undefined);
  assert.throws(() => ownerAuthConfig({ OWNER_OIDC_ISSUER: 'https://issuer.example' }, origin));
  const env = { OWNER_OIDC_ISSUER: 'https://issuer.example/pool', OWNER_OIDC_CLIENT_ID: 'client', OWNER_OIDC_LOGOUT_URL: 'https://login.example/logout' };
  assert.ok(ownerAuthConfig(env, origin));
  assert.ok(ownerAuthConfig(env, 'http://localhost:3000'));
  assert.throws(() => ownerAuthConfig(env, 'http://public.example'));
  assert.throws(() => ownerAuthConfig({ ...env, OWNER_OIDC_ISSUER: 'http://issuer.example' }, origin));
  const f = await fixture();
  try { assert.equal((await fetch(`${f.base}/api/v1/owner/login`)).status, 503); }
  finally { await f.stop(); }
});

test('owner identity and session survive database reopen and idempotent migrations', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { security } = await import('../src/security.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'owner-auth-restart-'));
  const config = { databaseUrl: process.env.TEST_DATABASE_URL, dataDir: join(dir, 'db') };
  const auth = security({ pepper: secret() });
  let db = await openDatabase(config);
  let id: string | undefined;
  try {
    const original = await new OwnerService(db, auth).establish(`https://${uuid()}.example`, 'restart-user');
    id = original.ownerId;
    await db.close();
    db = await openDatabase(config);
    const restored = new OwnerService(db, auth);
    assert.equal((await restored.authenticate(original.token)).id, id);
    await restored.revoke(original.token);
    await assert.rejects(restored.authenticate(original.token), { code: 'OWNER_UNAUTHORIZED' });
  } finally {
    if (id) await db.query('DELETE FROM owners WHERE id=$1', [id]);
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});
