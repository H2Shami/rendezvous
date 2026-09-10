import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../test/helpers.js';
import { Agent } from '../client/agent.js';

test('owner can create, observe untrusted content safely, revoke and close in a browser', async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const f = await fixture({ port, publicUrl: `http://127.0.0.1:${port}` });
  const dir = await mkdtemp(join(tmpdir(), 'rendezvous-browser-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(f.base);
    await page.getByRole('button', { name: 'Create a session' }).click();
    await page.locator('#room').waitFor({ state: 'visible' });
    const invitation = await page.locator('#invite-url').inputValue(); assert.ok(invitation.includes('#'));
    const a = await Agent.connect(invitation, join(dir, 'a.json'), '<img src=x onerror=alert(1)>');
    await a.send({ text: '<script>alert("payload")</script> is untrusted text.' });
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 1);
    assert.equal(await page.locator('#participants img').count(), 0);
    assert.equal(await page.locator('#messages script').count(), 0);
    assert.match(await page.locator('#messages').innerText(), /untrusted text/);
    await mkdir('.data', { recursive: true });
    await page.screenshot({ path: '.data/owner-ui.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '.data/owner-ui-mobile.png', fullPage: true });
    await page.locator('#participants button').click();
    await page.waitForFunction(() => document.querySelector('#participants').textContent.includes('revoked'));
    await assert.rejects(a.send({ text: 'revoked' }), e => e.code === 'PARTICIPANT_REVOKED');
    await page.getByRole('button', { name: 'Close session', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'CLOSED');
    assert.equal(await page.locator('.message').count(), 1);
    assert.deepEqual(pageErrors, []);
    await f.db.query('DELETE FROM sessions WHERE id=$1', [a.state.session_id]);
  } finally { await browser?.close(); await f.stop(); await rm(dir, { recursive: true, force: true }); }
});
