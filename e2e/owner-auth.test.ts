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
    await f.db.query('DELETE FROM owners WHERE issuer=$1', [workos.issuer]);
    await f.stop();
  }
});
