import assert from 'node:assert/strict';
import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { WorkOSProvider } from '../src/owners/provider.js';
import { secret, uuid } from '../src/validation.js';

/** Real SDK encryption/JWT/refresh against a controlled WorkOS transport. */
export async function workosFixture(origin = 'https://app.example') {
  const key = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'test', alg: 'RS256' };
  const settings = { apiKey: 'sk_test_secret', clientId: `client_${uuid().replaceAll('-', '')}`, publicOrigin: origin };
  const userId = `user_${uuid().replaceAll('-', '')}`, sessionId = `session_${uuid().replaceAll('-', '')}`;
  const state = { verified: true, lifetime: 300, refreshStatus: 200, logoutFails: false, revoked: false,
    corruptToken: false, subject: userId, method: 'GitHubOAuth', exchanges: 0, refreshes: 0, revocations: 0, codeVerifier: '' };
  const accessToken = (lifetime: number) => new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(state.subject)
    .setIssuer('https://api.workos.com').setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + lifetime).sign(key.privateKey);
  const sdk = new WorkOS(settings.apiKey, { clientId: settings.clientId, maxRetries: 0, fetchFn: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/user_management/sessions/revoke') {
      assert.equal(JSON.parse(String(init?.body)).session_id, sessionId);
      if (state.logoutFails) return Response.json({ message: 'PRIVATE_PROVIDER_ERROR' }, { status: 503 });
      state.revoked = true; state.revocations++;
      return new Response(null, { status: 204 });
    }
    assert.equal(path, '/user_management/authenticate');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.client_id, settings.clientId); assert.equal(body.client_secret, settings.apiKey);
    const refresh = body.grant_type === 'refresh_token';
    if (refresh) {
      state.refreshes++; assert.equal(body.refresh_token, 'PRIVATE_REFRESH_TOKEN');
      if (state.revoked || state.refreshStatus !== 200) return Response.json({ error: state.revoked ? 'invalid_grant' : 'provider_error', message: 'PRIVATE_PROVIDER_ERROR' }, { status: state.revoked ? 400 : state.refreshStatus });
    } else {
      state.exchanges++; state.codeVerifier = body.code_verifier;
      if (body.code !== 'valid') return Response.json({ error: 'invalid_grant', message: 'PRIVATE_TOKEN_AND_CODE' }, { status: 400 });
    }
    return Response.json({ user: { object: 'user', id: userId, email: 'owner@example.com', email_verified: state.verified,
      created_at: '2026-01-01', updated_at: '2026-01-01' }, access_token: (await accessToken(refresh ? 300 : state.lifetime)) + (state.corruptToken ? 'bad' : ''),
      refresh_token: state.corruptToken ? '' : 'PRIVATE_REFRESH_TOKEN', authentication_method: state.method });
  } });
  // Use a real local signature verifier; no external JWKS network dependency in tests.
  const jwks = createRemoteJWKSet(new URL('https://keys.example/jwks'), { [customFetch]: async () => Response.json({ keys: [jwk] }) });
  sdk.userManagement.getJWKS = async () => jwks;
  const password = secret();
  const provider = new WorkOSProvider(settings, password, sdk);
  return { provider, sdk, settings, password, state, userId, sessionId,
    issuer: `https://api.workos.com/client/${settings.clientId}`,
    callback: (state: string, code = 'valid') => new URL(`${origin}/api/v1/owner/callback?state=${state}&code=${code}`) };
}
