import { expect, test } from '@playwright/test';

test('terminal session shows idle state after input wait timeout', async ({ page }) => {
  const displayName = `E2E Awaiting ${Date.now()}`;

  try {
    await page.goto('/');
    await page.getByRole('combobox', { name: '服务器' }).selectOption({
      label: '全部',
    });
    await page.getByRole('combobox', { name: '类型' }).selectOption({
      label: '全部',
    });
    await page.getByRole('combobox', { name: '类别' }).selectOption({
      label: '全部',
    });
    await page.getByRole('textbox', { name: '目录' }).fill('');

    await page.getByTestId('new-session-toggle').click();
    await expect(page.getByTestId('new-session-dialog')).toHaveCount(0);
    await expect(page.getByTestId('host-dropdown-menu')).toBeVisible();
    await page.locator('.host-dropdown-item', { hasText: '本机' }).click();
    await expect(page.getByTestId('new-session-dialog')).toBeVisible();
    await page.getByTestId('new-session-name').fill(displayName);
    await page.getByTestId('new-session-kind-shell').click();
    await page.getByTestId('new-session-mode-direct').click();
    await page.getByTestId('new-session-dir').fill(process.cwd());
    await page.getByTestId('create-session').click();
    await expect(page.getByTestId('new-session-dialog')).toHaveCount(0);

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });

    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('.grid-card-badge')).toHaveText('运行中');

    await page.waitForTimeout(11_000);

    await expect(card.locator('.grid-card-badge')).toHaveText('空闲');
    await expect(card).toHaveClass(/card-idle/);
    await expect(page.locator('.stat-awaiting')).toHaveCount(0);
  } finally {
    await page
      .evaluate(async (nextDisplayName) => {
        const listResponse = await fetch('/api/agent-sessions');
        const list = await listResponse.json();
        const session = list.items.find(
          (item: { id: string; displayName: string }) =>
            item.displayName === nextDisplayName,
        );

        if (!session) {
          return;
        }

        await fetch(`/api/agent-sessions/${session.id}`, {
          method: 'DELETE',
        });
      }, displayName)
      .catch(() => {});
  }
});
