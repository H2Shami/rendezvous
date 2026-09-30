import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { OwnerService } from '../src/owners/service.js';
import { ownerAuthConfig } from '../src/owners/provider.js';
import { secret, uuid } from '../src/validation.js';
import { workosFixture } from './workos-fixture.js';

const origin = 'https://app.example';
test('owners retain stable identity, enforce ownership and disable access independently of WorkOS', async () => {
  const f = await fixture(); const owners = new OwnerService(f.db, f.auth, f.now);
  const issuer = `https://${uuid()}.example`;
  try {
    const a = await owners.establish(issuer, 'a'), b = await owners.establish(issuer, 'b');
    assert.notEqual(a.id, b.id);
    assert.equal((await owners.establish(issuer, 'a')).id, a.id);
    const principal = await new OwnerService(f.db, f.auth, f.now).authenticate(issuer, 'a');
    owners.requireOwnership(principal, a.id);
    assert.throws(() => owners.requireOwnership(principal, b.id), { code: 'NOT_FOUND' });
    assert.throws(() => owners.checkCsrf('session_a', owners.csrf('session_b')), { code: 'CSRF_INVALID' });
    owners.checkCsrf('session_a', owners.csrf('session_a'));
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1', [a.id]);
    await assert.rejects(owners.authenticate(issuer, 'a'), { code: 'OWNER_UNAUTHORIZED' });
    await assert.rejects(owners.establish(issuer, 'a'), { code: 'OWNER_DISABLED' });
  } finally { await f.db.query('DELETE FROM owners WHERE issuer=$1', [issuer]); await f.stop(); }
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
  const workos = await workosFixture(origin);
  const f = await fixture({ publicUrl: origin, ownerProvider: workos.provider, logger: e => logs.push(e) });
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
    workos.state.logoutFails = true;
    const unavailable = await call('logout', { method: 'POST', headers: { Cookie: authCookie, Origin: origin, 'X-CSRF-Token': me.csrf_token } });
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.getSetCookie().length, 0);
    assert.doesNotMatch(await unavailable.text(), /PRIVATE|refreshToken|accessToken/);
    workos.state.logoutFails = false;
    const logout = await call('logout', { method: 'POST', headers: { Cookie: authCookie, Origin: origin, 'X-CSRF-Token': me.csrf_token } });
    assert.equal(logout.status, 200); assert.equal(new URL((await logout.json()).logout_url).searchParams.get('session_id'), workos.sessionId);
    assert.equal(workos.state.revocations, 1);
    assert.match(logout.headers.getSetCookie().find(c => c.startsWith('__Host-rv-owner='))!, /Expires=Thu, 01 Jan 1970/);
    // An already-issued access token remains valid until expiry; WorkOS denies its next refresh.
    assert.equal((await call('me', { headers: { Cookie: authCookie } })).status, 200);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${state}|PRIVATE_TOKEN_AND_CODE|csrf_token|code=valid`));
  } finally {
    if (ownerId) await f.db.query('DELETE FROM owners WHERE id=$1', [ownerId]);
    await f.stop();
  }
});

test('owner auth is explicitly configured and rejects unsafe origins/provider URLs', async () => {
  assert.equal(ownerAuthConfig({}, 'https://app.example'), undefined);
  assert.throws(() => ownerAuthConfig({ WORKOS_CLIENT_ID: 'client_example' }, origin));
  const env = { WORKOS_API_KEY: 'sk_test_example', WORKOS_CLIENT_ID: 'client_example' };
  assert.ok(ownerAuthConfig(env, origin));
  assert.ok(ownerAuthConfig(env, 'http://localhost:3000'));
  assert.throws(() => ownerAuthConfig(env, 'http://public.example'));
  assert.throws(() => ownerAuthConfig({ ...env, WORKOS_API_KEY: 'invalid' }, origin));
  const f = await fixture();
  try { assert.equal((await fetch(`${f.base}/api/v1/owner/login`)).status, 503); }
  finally { await f.stop(); }
});

test('legacy provider routes are retired and stale attempts cannot authenticate through WorkOS', async () => {
  const workos = await workosFixture(origin);
  const f = await fixture({ publicUrl:origin, ownerProvider:workos.provider });
  const owners = new OwnerService(f.db,f.auth,f.now);
  const call = (path: string, cookie = '') => fetch(`${f.base}/api/v1/owner/${path}`, {redirect:'manual',headers:{Cookie:cookie}});
  try {
    assert.equal((await call('github/login')).status,404);
    assert.equal((await call('github/callback')).status,404);
    assert.equal((await fetch(`${f.base}/api/v1/owner/email/login`,{method:'POST'})).status,404);
    assert.equal((await call('login?screen=unknown')).status,400);
    const legacy = await owners.beginLogin('github');
    const wrong = await call(`callback?state=${legacy.state}&code=valid`,`__Host-rv-login=${legacy.browser}`);
    assert.match(wrong.headers.get('location')!,/sign_in_failed/);
  } finally { await f.stop(); }
});

test('Drizzle schema omits obsolete owner session storage and preserves owners on migration rerun', async () => {
  const f = await fixture(); const owners = new OwnerService(f.db, f.auth, f.now);
  const old = await owners.establish('https://github.com', uuid());
  try {
    const { applyMigrations } = await import('../src/migrations.js');
    await applyMigrations(f.db); await applyMigrations(f.db);
    assert.equal((await f.db.query('SELECT id FROM owners WHERE id=$1', [old.id])).rows.length, 1);
    assert.equal((await f.db.query("SELECT table_name FROM information_schema.tables WHERE table_name='owner_sessions'")).rows.length, 0);
  } finally { await f.db.query('DELETE FROM owners WHERE id=$1', [old.id]); await f.stop(); }
});
