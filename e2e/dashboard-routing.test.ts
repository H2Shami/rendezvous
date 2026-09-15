import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against a running Next dev server; all API traffic is mocked in the browser.
test('dashboard routes preserve private owner links and invitation handoff', { skip: !process.env.DASHBOARD_TEST_URL }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const base = process.env.DASHBOARD_TEST_URL!;
  const session = '11111111-1111-4111-8111-111111111111';
  const token = 'a'.repeat(43);
  const invitation = `${base}/join/${session}#${'b'.repeat(43)}`;
  const ownerPath = `/rooms/${session}#${session}.${token}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/sessions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/sessions') {
      assert.equal(request.method(), 'POST');
      assert.equal(request.postDataJSON().max_participants, 2);
      return route.fulfill({ status: 201, json: { session_id: session, owner_token: token, invite_url: invitation } });
    }
    assert.equal(request.headers().authorization, `Bearer ${token}`);
    if (path.endsWith('/messages')) {
      return route.fulfill({ json: { messages: [], cursor: 0, session_status: 'closed', participants: [] } });
    }
    return route.fulfill({ json: { status: 'CLOSED', expires_at: '2030-01-01', max_participants: 2, participants: [], invites: [] } });
  });
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create a session' }).click();
    await page.waitForURL(`${base}${ownerPath}`);
    await page.locator('#room').waitFor();
    assert.equal(await page.locator('#invite-url').inputValue(), invitation);
    assert.equal(await page.locator('#create').count(), 0);
    await page.reload();
    await page.locator('#room').waitFor();
    assert.equal(await page.locator('#copy-invite').isDisabled(), true);
    await page.goto(`${base}/#${session}.${token}`);
    await page.waitForURL(`${base}${ownerPath}`);
    await page.locator('#room').waitFor();
    await page.goto(`${base}/rooms/${session}`);
    await page.getByRole('alert').filter({ hasText: 'Open the full owner link' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
