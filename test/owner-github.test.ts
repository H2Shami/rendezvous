import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubProvider } from '../src/owners/github.js';
import { calculatePKCECodeChallenge } from 'openid-client';

test('GitHub exchanges browser-bound code with PKCE and uses numeric identity, never email', async () => {
  const calls: string[] = [];
  let identity: unknown = { id:12345, email:'not-an-identity@example.com' };
  let fail = false;
  const request: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'),'client-id');
      assert.equal(body.get('client_secret'),'client-secret');
      assert.equal(body.get('code_verifier'),'v'.repeat(64));
      assert.equal(body.get('redirect_uri'),'http://localhost:3000/api/v1/owner/github/callback');
      return Response.json(fail ? {error:'bad_verification_code'} : {access_token:'private-access-token',token_type:'bearer'});
    }
    assert.equal(url,'https://api.github.com/user');
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer private-access-token');
    return Response.json(identity);
  };
  const provider = new GitHubProvider('client-id','client-secret','http://localhost:3000', request);
  const checks = {state:'s'.repeat(43),verifier:'v'.repeat(64),nonce:'n'.repeat(64)};
  const authorize = new URL(await provider.authorize(checks));
  assert.equal(authorize.searchParams.get('code_challenge'),await calculatePKCECodeChallenge(checks.verifier));
  assert.equal(authorize.searchParams.get('scope'),'read:user');
  const callback = new URL(`http://localhost:3000/api/v1/owner/github/callback?state=${checks.state}&code=one-time-code`);
  assert.deepEqual(await provider.exchange(callback,checks),{issuer:'https://github.com',subject:'12345'});
  const count = calls.length;
  await assert.rejects(provider.exchange(callback,{...checks,state:'wrong'}));
  assert.equal(calls.length,count);
  identity = {email:'not-an-identity@example.com'};
  await assert.rejects(provider.exchange(callback,checks));
  fail = true;
  await assert.rejects(provider.exchange(callback,checks));
});
