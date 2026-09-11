import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture } from '../test/helpers.js';
import { testClient } from '../test/http-client.js';
import { createGateway } from '../scripts/proxy.js';

async function freePort() {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); return port;
}

test('owner can create, observe untrusted content safely, revoke and close in a browser', async () => {
  const port = await freePort(), frontendPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const f = await fixture({ publicUrl: base });
  const frontendDir = fileURLToPath(new URL('../frontend', import.meta.url));
  const frontend = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], {
    cwd: frontendDir, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let frontendLog = ''; frontend.stdout.on('data', chunk => { frontendLog += chunk; }); frontend.stderr.on('data', chunk => { frontendLog += chunk; });
  const gateway = createGateway(f.base, `http://127.0.0.1:${frontendPort}`);
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-browser-'));
  let browser;
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${frontendPort}`)).ok) break; } catch {}
      if (frontend.exitCode !== null || Date.now() > deadline) throw new Error(`Next failed to start: ${frontendLog}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise<void>(resolve => gateway.listen(port, '127.0.0.1', resolve));
    assert.equal((await fetch(f.base)).status, 404); // Express no longer serves the owner UI.
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    await page.route('**/api/v1/sessions', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<!DOCTYPE html><h1>Wrong upstream</h1>' }));
    await page.getByRole('button', { name: 'Create a session' }).click();
    await page.waitForFunction(() => document.querySelector('#error')!.textContent.includes('API routing error'));
    assert.match(await page.locator('#error').innerText(), /HTTP 404/);
    assert.match(await page.locator('#error').innerText(), /request /);
    await page.unroute('**/api/v1/sessions');
    await page.getByRole('button', { name: 'Create a session' }).click();
    await page.locator('#room').waitFor({ state: 'visible' });
    const invitation = await page.locator('#invite-url').inputValue(); assert.ok(invitation.includes('#'));
    await page.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { document.body.dataset.copied = text; } } })");
    await page.locator('#copy-invite').click();
    const copied = await page.evaluate(() => document.body.dataset.copied!);
    assert.ok(copied.includes(invitation)); assert.match(copied, /ordinary HTTP GET/); assert.match(copied, /curl/);
    const joinPage = await browser.newPage();
    await joinPage.goto(invitation);
    assert.match(await joinPage.locator('main').innerText(), /WAITING IS WORK/);
    assert.match(await joinPage.locator('main').innerText(), /participant_token/);
    assert.ok(await joinPage.locator('pre').isVisible());
    await mkdir('.data', { recursive: true });
    await joinPage.screenshot({ path: '.data/join-ui.png', fullPage: true });
    await joinPage.close();
    const a = await testClient(invitation, '<img src=x onerror=alert(1)>');
    await a.send('<script>alert(1)</script> is untrusted text.');
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 1);
    assert.equal(await page.locator('#messages script').count(), 0);
    assert.match(await page.locator('#messages').innerText(), /untrusted text/);
    await page.waitForFunction(() => document.querySelectorAll('.participant').length === 1);
    assert.equal(await page.locator('#participants img').count(), 0);
    assert.match(await page.locator('#participants').innerText(), /<img src=x/);
    await page.locator('#message-content').fill('Owner says <script>not executable</script>');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 2);
    assert.equal(await page.locator('#message-content').inputValue(), '');
    assert.match(await page.locator('.message').last().innerText(), /Owner/);
    assert.equal(await page.locator('#messages script').count(), 0);
    assert.equal((await a.poll(0)).messages.at(-1).sender_id, 'owner');
    const ownerUrl = page.url();
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 2);
    assert.equal(page.url(), ownerUrl);
    assert.equal(await page.locator('#copy-invite').isDisabled(), true); // No secret reconstructed from storage.
    await page.locator('#new-invite').click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#invite-url')!.value.startsWith('http'));
    assert.ok((await page.locator('#invite-url').inputValue()).startsWith(base));
    await mkdir('.data', { recursive: true });
    await page.screenshot({ path: '.data/owner-ui.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '.data/owner-ui-mobile.png', fullPage: true });
    await page.locator('#participants button').click();
    await page.waitForFunction(() => document.querySelector('#participants')!.textContent.includes('revoked'));
    await assert.rejects(a.poll(0), /UNAUTHORIZED/);
    await page.getByRole('button', { name: 'Close session', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#status')!.textContent === 'CLOSED');
    assert.equal(await page.locator('.message').count(), 2);
    assert.equal(await page.locator('#send-message').isDisabled(), true);
    assert.deepEqual(pageErrors, []);
    await f.db.query('DELETE FROM sessions WHERE id=$1', [a.membership.rendezvous_id]);
  } finally {
    await browser?.close(); gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    if (frontend.exitCode === null) { const stopped = once(frontend, 'exit'); frontend.kill('SIGTERM'); await stopped; }
    await f.stop(); await rm(dir, { recursive: true, force: true });
  }
});
