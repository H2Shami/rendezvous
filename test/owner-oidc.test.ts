import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { OidcProvider } from '../src/owners/provider.js';

// Exercises the real library against a signed local OIDC provider; no external account.
test('OIDC adapter validates signature, issuer, audience, expiry, nonce, state and PKCE', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
  const checks = { state: 'expected-state', nonce: 'expected-nonce', verifier: 'v'.repeat(43) };
  let issuer = '', mode = 'valid', exchanges = 0;
  const app = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }));
    } else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === '/token') {
      exchanges++;
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('code_verifier') !== checks.verifier) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: mode === 'issuer' ? 'https://wrong.example' : issuer, sub: 'stable-subject',
        aud: mode === 'audience' ? 'wrong-client' : 'client', exp: mode === 'expired' ? now - 600 : now + 300,
        iat: now, nonce: mode === 'nonce' ? 'wrong-nonce' : checks.nonce };
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const input = `${encode({ alg: 'RS256', kid: 'test' })}.${encode(claims)}`;
      const signature = mode === 'signature' ? Buffer.alloc(256).toString('base64url') : sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
      res.end(JSON.stringify({ access_token: 'unused-access-token', token_type: 'Bearer', id_token: `${input}.${signature}` }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const provider = new OidcProvider({ issuer, clientId: 'client', logoutEndpoint: `${issuer}/logout`, publicOrigin: 'https://app.example' },
      () => oidc.discovery(new URL(issuer), 'client', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] }));
    const url = new URL(await provider.authorize(checks));
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(checks.verifier).digest('base64url'));
    assert.equal(url.searchParams.get('nonce'), checks.nonce);
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/v1/owner/callback');
    const callback = () => new URL('https://app.example/api/v1/owner/callback?state=expected-state&code=authorization-code');
    assert.deepEqual(await provider.exchange(callback(), checks), { issuer, subject: 'stable-subject' });
    for (mode of ['signature', 'issuer', 'audience', 'expired', 'nonce']) await assert.rejects(provider.exchange(callback(), checks), mode);
    mode = 'valid';
    const before = exchanges;
    await assert.rejects(provider.exchange(callback(), { ...checks, state: 'wrong-state' }));
    assert.equal(exchanges, before);
    await assert.rejects(provider.exchange(callback(), { ...checks, verifier: 'wrong' }));
    assert.equal(new URL(provider.logoutUrl()).searchParams.get('logout_uri'), 'https://app.example/account');
  } finally { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
});
