import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkOSProvider } from '../src/owners/provider.js';
import { OwnerService } from '../src/owners/service.js';
import { fixture } from './helpers.js';
import { workosFixture } from './workos-fixture.js';
import { secret } from '../src/validation.js';

const checks = { state: 's'.repeat(43), verifier: 'v'.repeat(64) };

test('WorkOS SDK seals code exchange, validates JWTs and fails closed on invalid callbacks or cookies', async () => {
  const w = await workosFixture();
  const { provider } = w;
  const url = new URL(await provider.authorize(checks));
  assert.equal(url.origin, 'https://api.workos.com');
  assert.equal(url.searchParams.get('provider'), 'authkit');
  assert.equal(url.searchParams.get('state'), checks.state);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(checks.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('redirect_uri'), `${w.settings.publicOrigin}/api/v1/owner/callback`);
  assert.equal(new URL(await provider.authorize(checks, 'sign-up')).searchParams.get('screen_hint'), 'sign-up');
  const identity = await provider.exchange(w.callback(checks.state), checks);
  assert.equal(w.state.codeVerifier, checks.verifier);
  assert.equal(identity.subject, w.userId);
  assert.doesNotMatch(identity.sealedSession, /PRIVATE|owner@example|accessToken|refreshToken/);
  assert.equal((await provider.authenticate(identity.sealedSession)).subject, w.userId);
  for (const bad of [
    w.callback('wrong'), new URL(`${w.callback(checks.state)}&state=duplicate`),
    new URL(`${w.callback(checks.state)}&code=duplicate`), new URL(`${w.callback(checks.state)}&error=access_denied`),
    new URL(`https://evil.example/api/v1/owner/callback?state=${checks.state}&code=valid`),
  ]) await assert.rejects(provider.exchange(bad, checks), { code: 'LOGIN_INVALID' });
  assert.equal(w.state.exchanges, 1);
  for (const cookie of ['', secret(), `${identity.sealedSession.slice(0, 40)}x${identity.sealedSession.slice(41)}`])
    await assert.rejects(provider.authenticate(cookie), { code: 'OWNER_UNAUTHORIZED' });
  const wrongKey = new WorkOSProvider(w.settings, secret(), w.sdk);
  await assert.rejects(wrongKey.authenticate(identity.sealedSession), { code: 'OWNER_UNAUTHORIZED' });
  // A valid encrypted envelope does not bypass token signature validation.
  w.state.corruptToken = true;
  const corrupt = await provider.exchange(w.callback(checks.state), checks);
  await assert.rejects(provider.authenticate(corrupt.sealedSession), { code: 'OWNER_UNAUTHORIZED' });
  w.state.corruptToken = false;
  w.state.verified = false;
  await assert.rejects(provider.exchange(w.callback(checks.state), checks), { code: 'OWNER_UNAUTHORIZED' });
  w.state.verified = true; w.state.subject = 'user_someoneelse';
  await assert.rejects(provider.exchange(w.callback(checks.state), checks), { code: 'OWNER_UNAUTHORIZED' });
});

test('WorkOS refresh persists renewed cookies, preserves session identity, and enforces revocation on refresh', async () => {
  const w = await workosFixture(); w.state.lifetime = -60;
  const expired = await w.provider.exchange(w.callback(checks.state), checks);
  const refreshed = await w.provider.authenticate(expired.sealedSession);
  assert.ok(refreshed.sealedSession); assert.notEqual(refreshed.sealedSession, expired.sealedSession);
  assert.equal(refreshed.sessionId, expired.sessionId); assert.ok(refreshed.expiresAt.getTime() > Date.now());
  assert.equal(w.state.refreshes, 1);
  await w.provider.authenticate(refreshed.sealedSession);
  assert.equal(w.state.refreshes, 1);
  const logout = new URL(await w.provider.logout(refreshed.sessionId));
  assert.equal(logout.searchParams.get('return_to'), `${w.settings.publicOrigin}/account`);
  assert.equal(w.state.revocations, 1);
  await assert.rejects(w.provider.authenticate(expired.sealedSession), { code: 'OWNER_UNAUTHORIZED' });
  // Access tokens are locally validated until their short expiry, including after logout.
  assert.equal((await w.provider.authenticate(refreshed.sealedSession)).sessionId, w.sessionId);
});

test('transient WorkOS refresh/logout failures are retryable and never expose credentials', async () => {
  const w = await workosFixture(); w.state.lifetime = -60;
  const expired = await w.provider.exchange(w.callback(checks.state), checks);
  w.state.refreshStatus = 503;
  await assert.rejects(w.provider.authenticate(expired.sealedSession), { code: 'AUTH_UNAVAILABLE', status: 503 });
  w.state.refreshStatus = 200;
  assert.ok((await w.provider.authenticate(expired.sealedSession)).sealedSession);
  w.state.logoutFails = true;
  await assert.rejects(w.provider.logout(w.sessionId), { code: 'AUTH_UNAVAILABLE', status: 503 });
  assert.equal(w.state.revoked, false);
});

test('linked password, Google and GitHub credentials map to one owner without local sessions', async () => {
  const w = await workosFixture(), f = await fixture();
  const owners = new OwnerService(f.db, f.auth, f.now), ids: string[] = [];
  try {
    for (const method of ['Password', 'GoogleOAuth', 'GitHubOAuth']) {
      w.state.method = method;
      const identity = await w.provider.exchange(w.callback(checks.state), checks);
      ids.push((await owners.establish(identity.issuer, identity.subject)).id);
    }
    assert.equal(new Set(ids).size, 1);
    assert.equal((await f.db.query("SELECT table_name FROM information_schema.tables WHERE table_name='owner_sessions'")).rows.length, 0);
  } finally { await f.db.query('DELETE FROM owners WHERE issuer=$1', [w.issuer]); await f.stop(); }
});
