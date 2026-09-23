import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

export async function checkFriendControls(page: Page, agentId: string) {
  const peerId = await page.evaluate(async () => {
    const { csrf_token } = await (await fetch('/api/v1/owner/me')).json();
    const response = await fetch('/api/v1/owner/agents', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token,
    }, body: JSON.stringify({ display_name: 'Friend UI peer' }) });
    if (!response.ok) throw new Error('Peer setup failed');
    return (await response.json()).agent.id as string;
  });
  const panel = page.getByRole('region', { name: 'Friends', exact: true });
  const id = panel.getByLabel('Friend’s agent ID', { exact: true });
  await panel.getByText('No friends yet.', { exact: false }).waitFor();
  await id.fill(agentId);
  await panel.getByRole('button', { name: 'Add friend', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('cannot add itself');
  await id.fill(peerId);
  await panel.getByLabel('Allow outgoing conversations', { exact: false }).check();
  await panel.getByRole('button', { name: 'Add friend', exact: true }).click();
  await expect(panel.locator('li')).toContainText('Incoming: Not allowed · Outgoing: Allowed by you');
  const read = () => page.evaluate(async ({ agentId, peerId }) => {
    const own = await (await fetch(`/api/v1/owner/agents/${agentId}/peers/${peerId}`)).json();
    const reverse = await fetch(`/api/v1/owner/agents/${peerId}/peers/${agentId}`);
    return { policy: own.policy, reverse: reverse.status };
  }, { agentId, peerId });
  assert.equal((await read()).reverse, 404);
  await page.reload();
  await expect(panel.locator('li')).toContainText(peerId);
  await panel.getByRole('button', { name: 'Edit permissions', exact: true }).click();
  await panel.getByLabel('Allow incoming conversations', { exact: false }).check();
  await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await expect(panel.locator('li')).toContainText('Incoming: Allowed by you · Outgoing: Allowed by you');
  assert.equal((await read()).policy.allow_inbound, true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: '/tmp/rendezvous-friends-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.screenshot({ path: '/tmp/rendezvous-friends-desktop.png' });
  await panel.getByRole('button', { name: 'Edit permissions', exact: true }).click();
  await panel.getByLabel('Allow outgoing conversations', { exact: false }).uncheck();
  await page.route('**/peers/*', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }) : route.continue());
  page.once('dialog', dialog => void dialog.accept());
  await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Permission change rejected');
  assert.equal((await read()).policy.allow_outbound, true);
  await page.unroute('**/peers/*');
  await panel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Edit permissions', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Edit permissions', exact: true }).click();
  await panel.getByLabel('Allow outgoing conversations', { exact: false }).uncheck();
  page.once('dialog', dialog => void dialog.accept());
  await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await expect(panel.locator('li')).toContainText('Incoming: Allowed by you · Outgoing: Not allowed');
  assert.equal((await read()).policy.allow_outbound, false);
  page.once('dialog', dialog => void dialog.dismiss());
  await panel.getByRole('button', { name: 'Remove friend', exact: true }).click();
  await expect(panel.locator('li')).toHaveCount(1);
  page.once('dialog', dialog => void dialog.accept());
  await panel.getByRole('button', { name: 'Remove friend', exact: true }).click();
  await expect(panel.locator('li')).toHaveCount(0);
  await page.reload();
  await panel.getByText('No friends yet.', { exact: false }).waitFor();
}
