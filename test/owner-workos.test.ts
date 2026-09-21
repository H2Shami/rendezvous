import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkOS } from '@workos-inc/node';
import { WorkOSProvider } from '../src/owners/provider.js';
import { OwnerService } from '../src/owners/service.js';
import { fixture } from './helpers.js';
import { uuid } from '../src/validation.js';

const origin = 'http://localhost:3000';
const checks = {state:'s'.repeat(43),verifier:'v'.repeat(64)};
const token = (sid: unknown) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sid})).toString('base64url')}.c2lnbmF0dXJl`;

test('WorkOS SDK uses AuthKit, state, PKCE and server-side credentials; callbacks fail closed', async () => {
  let calls = 0, verified = true, sessionId: unknown = 'session_test', fail = false;
  const sdk = new WorkOS('sk_test_secret', {clientId:'client_test',maxRetries:0,fetchFn:async (input,init) => {
    calls++;
    assert.equal(String(input),'https://api.workos.com/user_management/authenticate');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.client_id,'client_test');
    assert.equal(body.client_secret,'sk_test_secret');
    assert.equal(body.code_verifier,checks.verifier);
    assert.equal(body.code,'one-time-code');
    return fail ? Response.json({message:'PRIVATE_PROVIDER_ERROR',error:'invalid_grant'},{status:400}) : Response.json({
      user:{object:'user',id:'user_test',email:'owner@example.com',email_verified:verified,created_at:'2026-01-01',updated_at:'2026-01-01'},
      access_token:token(sessionId),refresh_token:'PRIVATE_REFRESH_TOKEN',authentication_method:'GitHubOAuth',
    });
  }});
  const provider = new WorkOSProvider({apiKey:'sk_test_secret',clientId:'client_test',publicOrigin:origin},sdk);
  const url = new URL(await provider.authorize(checks));
  assert.equal(url.origin,'https://api.workos.com');
  assert.equal(url.searchParams.get('provider'),'authkit');
  assert.equal(url.searchParams.get('state'),checks.state);
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(checks.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('redirect_uri'),`${origin}/api/v1/owner/callback`);
  assert.equal(new URL(await provider.authorize(checks,'sign-up')).searchParams.get('screen_hint'),'sign-up');
  const callback = () => new URL(`${origin}/api/v1/owner/callback?state=${checks.state}&code=one-time-code`);
  const identity = await provider.exchange(callback(),checks);
  assert.deepEqual(identity,{issuer:'https://api.workos.com/client/client_test',subject:'user_test',sessionId:'session_test'});
  for (const bad of [
    new URL(`${origin}/api/v1/owner/callback?state=wrong&code=one-time-code`),
    new URL(`${callback()}&state=duplicate`),new URL(`${callback()}&code=duplicate`),
    new URL(`${callback()}&error=access_denied`),
    new URL(`https://evil.example/api/v1/owner/callback?state=${checks.state}&code=one-time-code`),
  ]) await assert.rejects(provider.exchange(bad,checks),{code:'LOGIN_INVALID'});
  assert.equal(calls,1);
  verified = false;
  await assert.rejects(provider.exchange(callback(),checks),{code:'LOGIN_INVALID'});
  verified = true; sessionId = undefined;
  await assert.rejects(provider.exchange(callback(),checks),{code:'LOGIN_INVALID'});
  fail = true;
  await assert.rejects(provider.exchange(callback(),checks));
  const logout = new URL(provider.logoutUrl('session_test'));
  assert.equal(logout.searchParams.get('session_id'),'session_test');
  assert.equal(logout.searchParams.get('return_to'),`${origin}/account`);
  assert.equal(provider.logoutUrl(),`${origin}/account`);
  assert.doesNotMatch(JSON.stringify(identity),/PRIVATE|email|accessToken|refreshToken/);
});

test('linked password, Google and GitHub credentials map to the same internal owner', async () => {
  const userId = `user_${uuid().replaceAll('-','')}`;
  let method = 'Password';
  const sdk = new WorkOS('sk_test_secret',{maxRetries:0,fetchFn:async()=>Response.json({
    user:{object:'user',id:userId,email:'owner@example.com',email_verified:true,created_at:'2026-01-01',updated_at:'2026-01-01'},
    access_token:token('session_test'),refresh_token:'PRIVATE_REFRESH_TOKEN',authentication_method:method,
  })});
  const provider = new WorkOSProvider({apiKey:'sk_test_secret',clientId:'client_test',publicOrigin:origin},sdk);
  const f = await fixture(); const service = new OwnerService(f.db,f.auth,f.now);
  const owners: string[] = [];
  try {
    for (method of ['Password','GoogleOAuth','GitHubOAuth']) {
      const identity = await provider.exchange(new URL(`${origin}/api/v1/owner/callback?state=${checks.state}&code=one-time-code`),checks);
      owners.push((await service.establish(identity.issuer,identity.subject,'',identity.sessionId)).ownerId);
    }
    assert.equal(new Set(owners).size,1);
    assert.equal((await f.db.query('SELECT id FROM owners WHERE subject=$1',[userId])).rows.length,1);
  } finally { await f.db.query('DELETE FROM owners WHERE subject=$1',[userId]); await f.stop(); }
});
