import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer, type AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture } from '../test/helpers.js';
import { workosFixture } from '../test/workos-fixture.js';

test('hosted AuthKit login and logout traverse the Next proxy with independent browser sessions', async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const frontendPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${frontendPort}`;
  const workos = await workosFixture(origin);
  // Bypass the hosted UI, but exercise real SDK code exchange, sealing and refresh.
  workos.provider.authorize = async c => workos.callback(c.state).href;
  workos.state.lifetime = -60;
  const f = await fixture({ publicUrl: origin, ownerProvider: workos.provider });
  const frontend = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], {
    cwd: fileURLToPath(new URL('../frontend', import.meta.url)),
    env: { ...process.env, EXPRESS_URL: f.base, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; frontend.stdout.on('data', c => { logs += c; }); frontend.stderr.on('data', c => { logs += c; });
  let browser;
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (frontend.exitCode !== null || Date.now() > deadline) throw new Error(`Next startup failed: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    // Hosted logout is external UI; emulate its redirect for the fake WorkOS session.
    await context.route('https://api.workos.com/user_management/sessions/logout?**', async route => {
      assert.equal(new URL(route.request().url()).searchParams.get('session_id'), workos.sessionId);
      await route.fulfill({ status: 302, headers: { location: `${origin}/account` } });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/account`);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    assert.equal(page.url(), `${origin}/account`);
    const cookies = await context.cookies();
    const session = cookies.find(c => c.name === 'rv-owner');
    assert.ok(session?.httpOnly); assert.equal(session.sameSite, 'Lax');
    assert.equal(cookies.some(c => c.name === 'rv-login'), false);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.equal(await page.evaluate(() => document.cookie.includes('rv-owner')), false);
    await page.reload();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    // Register and issue through the dashboard, then use the key as a real runtime.
    await page.getByRole('link', { name: 'Manage agents ↗', exact: true }).click();
    await page.getByLabel('Agent name', { exact: true }).fill('Browser agent draft');
    await page.getByRole('button', { name: 'Register agent', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser agent draft', exact: true }).waitFor();
    const registeredId = await page.getByLabel('Public agent ID', { exact: true }).inputValue();
    await page.getByText('Offline', { exact: true }).waitFor();
    await page.getByLabel('Agent name', { exact: true }).fill('Browser agent');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser agent', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Generate API key', exact: true }).click();
    await page.getByLabel('New API key', { exact: true }).waitFor();
    const dashboardKey = await page.getByLabel('New API key', { exact: true }).inputValue();
    assert.ok(dashboardKey.startsWith('agk_'));
    await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
    await page.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), dashboardKey);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(page.url().includes(dashboardKey), false);
    await page.getByRole('button', { name: 'I saved the key', exact: true }).click();
    await page.reload();
    await page.getByRole('heading', { name: 'Browser agent', exact: true }).waitFor();
    assert.equal(await page.locator('#new-api-key').count(), 0);
    assert.equal((await page.content()).includes(dashboardKey), false);
    // A failed presence refresh must not present the previous status as current.
    await page.route('**/api/v1/owner/agents/*/presence', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.reload();
    await page.getByText('Status unavailable', { exact: true }).waitFor();
    await page.unroute('**/api/v1/owner/agents/*/presence');
    await page.reload();
    await page.getByText('Offline', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/rendezvous-agent-settings.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Management requests use the real SDK session and CSRF through Next's proxy.
    const createdAgent = await page.evaluate(async ({ registeredId, dashboardKey }) => {
      const me = await (await fetch('/api/v1/owner/me')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
      const { agent } = await (await fetch(`/api/v1/owner/agents/${registeredId}`)).json();
      const peerResponse = await fetch('/api/v1/owner/agents', { method: 'POST', headers, body: JSON.stringify({ display_name: 'Browser peer' }) });
      if (peerResponse.status !== 201) throw new Error('Peer creation failed');
      const { agent: peer } = await peerResponse.json();
      const policyPath = `/api/v1/owner/agents/${agent.id}/peers/${peer.id}`;
      const saved = await fetch(policyPath, { method: 'PUT', headers, body: JSON.stringify({ allow_inbound: false, allow_outbound: true }) });
      if (saved.status !== 200) throw new Error('Policy creation failed');
      const { policy } = await (await fetch(policyPath)).json();
      if (!policy.allow_outbound || policy.allow_inbound) throw new Error('Incorrect policy flags');
      if ((await fetch(policyPath, { method: 'DELETE', headers })).status !== 200) throw new Error('Policy deletion failed');
      if ((await fetch(policyPath)).status !== 404) throw new Error('Deleted policy still present');
      const { credentials } = await (await fetch(`/api/v1/owner/agents/${agent.id}/credentials`)).json();
      const credential = credentials.find((c: { revoked_at: string | null }) => !c.revoked_at);
      const api_key = dashboardKey;
      const runtime = await fetch('/api/v1/agents/me', { headers: { Authorization: `Bearer ${api_key}` } });
      if ((await runtime.json()).agent.id !== agent.id) throw new Error('Wrong runtime identity');
      const receiverHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` };
      const acquired = await fetch('/api/v1/agents/me/receiver', { method: 'POST', headers: receiverHeaders,
        body: JSON.stringify({ connection_id: crypto.randomUUID(), takeover: false }) });
      if (acquired.status !== 201) throw new Error('Receiver acquisition failed');
      const { receiver } = await acquired.json();
      const heartbeat = await fetch('/api/v1/agents/me/receiver/heartbeat', { method: 'POST', headers: receiverHeaders,
        body: JSON.stringify({ receiver, accepting_sessions: true }) });
      if (heartbeat.status !== 200) throw new Error('Receiver heartbeat failed');
      const peerIssued = await (await fetch(`/api/v1/owner/agents/${peer.id}/credentials`, { method: 'POST', headers, body: '{}' })).json();
      const peerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${peerIssued.api_key}` };
      const peerLease = await (await fetch('/api/v1/agents/me/receiver', { method: 'POST', headers: peerHeaders, body: JSON.stringify({ connection_id: crypto.randomUUID(), takeover: false }) })).json();
      for (const [left, right] of [[agent.id, peer.id], [peer.id, agent.id]]) {
        const grant = await fetch(`/api/v1/owner/agents/${left}/peers/${right}`, { method: 'PUT', headers, body: JSON.stringify({ allow_inbound: true, allow_outbound: true }) });
        if (!grant.ok) throw new Error('Grant failed');
      }
      const opened = await fetch('/api/v1/agent-sessions', { method: 'POST', headers: receiverHeaders, body: JSON.stringify({ receiver, recipient_agent_id: peer.id, idempotency_key: crypto.randomUUID(), binding_id: crypto.randomUUID() }) });
      if (opened.status !== 201) throw new Error('Session open failed');
      const { session } = await opened.json();
      const accepted = await fetch(`/api/v1/agent-sessions/${session.id}/accept`, { method: 'POST', headers: peerHeaders, body: JSON.stringify({ receiver: peerLease.receiver, binding_id: crypto.randomUUID() }) });
      if (!accepted.ok) throw new Error('Session accept failed');
      const sent = await fetch(`/api/v1/agent-sessions/${session.id}/messages`, { method: 'POST', headers: receiverHeaders, body: JSON.stringify({ receiver, client_message_id: crypto.randomUUID(), content: 'Agent hello' }) });
      if (sent.status !== 201) throw new Error('Agent send failed');
      return { agentId: agent.id, sessionId: session.id, credentialId: credential.id, apiKey: api_key };
    }, { registeredId, dashboardKey });
    const { agentId, sessionId } = createdAgent;
    await page.reload();
    await page.getByText('Online · busy', { exact: true }).waitFor();
    await page.goto(`${origin}/account`);
    await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
    await page.getByRole('link', { name: 'Browser agent ↔ Browser peer', exact: true }).click();
    assert.equal(page.url(), `${origin}/rooms/${sessionId}`);
    await page.locator('#messages').getByText('Agent hello', { exact: true }).waitFor();
    await page.locator('#message-content').fill('Human intervention');
    await page.locator('#send-message').click();
    await page.locator('#messages').getByText('Human intervention', { exact: true }).waitFor();
    await page.locator('#messages').getByText('Human owner', { exact: true }).waitFor();
    assert.equal(await page.locator('#copy-invite').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/rendezvous-owner-agent-room.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const human = await f.db.query<{ sender_owner_id: string }>('SELECT sender_owner_id FROM messages WHERE session_id=$1 AND content=$2', [sessionId, 'Human intervention']);
    assert.ok(human.rows[0].sender_owner_id);
    await page.locator('#close-session').click();
    await page.locator('#status').filter({ hasText: 'CLOSED' }).waitFor();
    await page.goto(`${origin}/settings/agents/${agentId}`);
    page.on('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
    await page.getByLabel('New API key', { exact: true }).waitFor();
    const replacement = await page.getByLabel('New API key', { exact: true }).inputValue();
    assert.notEqual(replacement, dashboardKey);
    const statuses = await page.evaluate(async ({ oldKey, newKey }) => {
      return [(await fetch('/api/v1/agents/me', { headers: { Authorization: `Bearer ${oldKey}` } })).status,
        (await fetch('/api/v1/agents/me', { headers: { Authorization: `Bearer ${newKey}` } })).status];
    }, { oldKey: dashboardKey, newKey: replacement });
    assert.deepEqual(statuses, [401, 200]);
    await page.getByRole('button', { name: 'I saved the key', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await page.getByText('Key revoked.', { exact: true }).waitFor();
    const revokedStatus = await page.evaluate(async key => (await fetch('/api/v1/agents/me', { headers: { Authorization: `Bearer ${key}` } })).status, replacement);
    assert.equal(revokedStatus, 401);
    await page.getByRole('button', { name: 'Disable agent', exact: true }).click();
    await page.getByRole('button', { name: 'Agent disabled', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Generate API key', exact: true }).isDisabled(), true);
    const ended = await f.db.query<{ ended_at: Date }>('SELECT ended_at FROM agent_receivers WHERE agent_id=$1', [agentId]);
    assert.ok(ended.rows[0].ended_at);
    await page.goto(`${origin}/account`);
    const other = await browser.newContext(); const otherPage = await other.newPage();
    await otherPage.goto(`${origin}/account`);
    await otherPage.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
    assert.equal((await context.cookies()).some(c => c.name === 'rv-owner'), false);
    const replay = await fetch(`${origin}/api/v1/owner/me`, { headers: { Cookie: `rv-owner=${session.value}` } });
    assert.equal(replay.status, 200); // Already-issued JWT remains valid until expiry.
    assert.equal(workos.state.revocations, 1);
    assert.equal(workos.state.refreshes, 1); // Refreshed cookie survived the Next proxy.
    await page.goto(`${origin}/account?error=sign_in_failed`);
    await page.locator('.account-panel').getByRole('alert').waitFor();
    assert.match(await page.locator('.account-panel').getByRole('alert').innerText(), /could not be completed/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  } finally {
    await browser?.close();
    if (frontend.exitCode === null) { const stopped = once(frontend, 'exit'); frontend.kill('SIGTERM'); await stopped; }
    await f.db.query('DELETE FROM sessions WHERE id IN (SELECT s.id FROM agent_sessions s JOIN agents a ON a.id=s.initiator_agent_id JOIN owners o ON o.id=a.owner_id WHERE o.issuer=$1)', [workos.issuer]);
    await f.db.query('DELETE FROM agent_receivers WHERE agent_id IN (SELECT a.id FROM agents a JOIN owners o ON a.owner_id=o.id WHERE o.issuer=$1)', [workos.issuer]);
    await f.db.query('DELETE FROM agent_connections WHERE agent_id IN (SELECT a.id FROM agents a JOIN owners o ON a.owner_id=o.id WHERE o.issuer=$1)', [workos.issuer]);
    await f.db.query('DELETE FROM agent_credentials WHERE agent_id IN (SELECT a.id FROM agents a JOIN owners o ON a.owner_id=o.id WHERE o.issuer=$1)', [workos.issuer]);
    await f.db.query('DELETE FROM agents WHERE owner_id IN (SELECT id FROM owners WHERE issuer=$1)', [workos.issuer]);
    await f.db.query('DELETE FROM owners WHERE issuer=$1', [workos.issuer]);
    await f.stop();
  }
});
