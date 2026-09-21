import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { CognitoEmailAuth, type EmailAuth } from '../src/owners/email.js';
import { fixture } from './helpers.js';
import { HttpError, uuid } from '../src/validation.js';

const origin = 'https://app.example';
test('email login verifies Cognito signature, audience, issuer, token use and expiry', async t => {
  const issuer = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_test';
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const client = new CognitoIdentityProviderClient({ region: 'us-east-2' });
  let token = '';
  t.mock.method(client, 'send', async (command: { input: Record<string, unknown> }) => {
    assert.equal(command.input.AuthFlow, 'USER_PASSWORD_AUTH');
    return { AuthenticationResult: { IdToken: token } };
  });
  const email = new CognitoEmailAuth(issuer, 'web-client', {client, keys:createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'test'}]})});
  const sign = (overrides = {}, key = keys.privateKey) => new SignJWT({ iss:issuer, sub:'stable-user', aud:'web-client', token_use:'id', exp:Math.floor(Date.now()/1000)+60, ...overrides }).setProtectedHeader({alg:'RS256',kid:'test'}).sign(key);
  token = await sign();
  assert.deepEqual(await email.login('owner@example.com','password'), {issuer,subject:'stable-user'});
  for (const claims of [{iss:'https://evil.example'}, {aud:'other'}, {exp:0}, {token_use:'access'}, {sub:''}]) {
    token = await sign(claims);
    await assert.rejects(email.login('owner@example.com','password'), {code:'AUTH_UNAVAILABLE'});
  }
  token = await sign({}, other.privateKey);
  await assert.rejects(email.login('owner@example.com','password'), {code:'AUTH_UNAVAILABLE'});
});

test('unconfirmed email recovery, login cookies, request validation and delivery limits', async () => {
  const issuer = `https://${uuid()}.example`;
  const logs: unknown[] = [];
  let confirmed = false;
  let deliveries = 0;
  const email: EmailAuth = {
    async login(address, password) {
      assert.equal(address, 'owner@example.com'); assert.equal(password, 'PRIVATE_PASSWORD');
      if (!confirmed) throw new HttpError('CONFIRMATION_REQUIRED','Verify your email.',409);
      return {issuer,subject:'owner'};
    },
    async signup() { throw new HttpError('ACCOUNT_EXISTS','Account exists.',409); },
    async confirm(_email, code) { if (code !== '123456') throw new HttpError('INVALID_CODE','Incorrect code.'); confirmed = true; },
    async resend() { deliveries++; }, async forgot() { deliveries++; }, async reset() {},
  };
  const f = await fixture({publicUrl:origin,ownerEmail:email,logger:e=>logs.push(e)});
  const post = (action: string, body: unknown, headers: Record<string,string> = {Origin:origin}) => fetch(`${f.base}/api/v1/owner/email/${action}`, {method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const login = {email:'OWNER@example.com',password:'PRIVATE_PASSWORD'};
  try {
    assert.equal((await post('login',login,{})).status,403);
    assert.equal((await post('login',{...login, owner_id:uuid()})).status,400);
    assert.equal((await post('login',login)).status,409);
    assert.equal((await post('confirm',{email:login.email,code:'000000'})).status,400);
    assert.equal((await post('resend',{email:login.email})).status,200);
    assert.equal((await post('confirm',{email:login.email,code:'123456'})).status,200);
    const response = await post('login',login);
    assert.equal(response.status,200);
    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie,/HttpOnly/); assert.match(cookie,/Secure/);
    const me = await fetch(`${f.base}/api/v1/owner/me`,{headers:{Cookie:cookie.split(';')[0]}});
    assert.equal(me.status,200);
    for (let i=0;i<4;i++) assert.equal((await post('forgot',{email:login.email})).status,200);
    assert.equal((await post('resend',{email:login.email})).status,429);
    assert.equal(deliveries,5);
    assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_PASSWORD|123456|OWNER@example/);
  } finally { await f.db.query('DELETE FROM owners WHERE issuer=$1',[issuer]); await f.stop(); }
});
