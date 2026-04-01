import { expect, test, type APIRequestContext } from '@playwright/test';

declare const process: {
  cwd(): string;
};

/** Clean up all window-capture sessions before each test */
async function cleanupCaptureSessions(request: APIRequestContext) {
  const res = await request.get('/api/agent-sessions');
  const data = await res.json();
  for (const s of data.items) {
    if (s.sourceType === 'local-window-capture') {
      const deleteRes = await request
        .delete(`/api/agent-sessions/${s.id}`)
        .catch(() => null);

      if (!deleteRes || deleteRes.status() !== 204) {
        // Force transition to exited and try again
        await request
          .post(`/api/agent-sessions/${s.id}/observe-state`, {
            data: {
              kind: 'transition',
              observeToken: 'force-cleanup',
              connectionState: 'offline',
              interactionState: 'exited',
              stateConfidence: 'high',
            },
          })
          .catch(() => {});
        await request
          .delete(`/api/agent-sessions/${s.id}`)
          .catch(() => {});
      }
    }
  }
}

/**
 * Mock getDisplayMedia for E2E tests.
 * Creates a real MediaStream via canvas so the browser treats it as valid.
 */
async function mockGetDisplayMedia(
  page: import('@playwright/test').Page,
  label = 'VS Code - Mock Window',
) {
  await page.addInitScript((trackLabel: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#ffffff';
      ctx.font = '24px monospace';
      ctx.fillText('VS Code Mock', 50, 240);
    }

    const mockStream = canvas.captureStream(1);
    const track = mockStream.getVideoTracks()[0];

    Object.defineProperty(track, 'label', {
      value: trackLabel,
      writable: false,
    });

    (window as any).__mockCaptureTrack = track;
    (window as any).__mockCaptureStream = mockStream;

    navigator.mediaDevices.getDisplayMedia = async () => mockStream;
  }, label);
}

test('window capture: 顶栏存在添加按钮', async ({ page, request }) => {
  await cleanupCaptureSessions(request);
  await page.goto('/');
  await expect(page.locator('.top-bar')).toBeVisible();
  await expect(
    page.locator('.top-bar-action', { hasText: '添加 VS Code 窗口' }),
  ).toBeVisible();
});

test('window capture: 点击添加后创建 capture session', async ({
  page,
  request,
}) => {
  await cleanupCaptureSessions(request);
  const uniqueName = `VSCode-E2E-${Date.now()}`;

  try {
    await mockGetDisplayMedia(page, uniqueName);
    await page.goto('/');
    await expect(page.locator('.top-bar')).toBeVisible();

    await page
      .locator('.top-bar-action', { hasText: '添加 VS Code 窗口' })
      .click();

    const captureCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: uniqueName }),
    });
    await expect(captureCard).toBeVisible({ timeout: 10000 });
    await expect(captureCard.locator('.grid-card-kind')).toContainText(
      'vscode',
    );
  } finally {
    await cleanupCaptureSessions(request);
  }
});

test('window capture: 静止画面会从运行中切换为空闲', async ({
  page,
  request,
}) => {
  await cleanupCaptureSessions(request);
  const uniqueName = `VSCode-Stable-${Date.now()}`;

  try {
    await mockGetDisplayMedia(page, uniqueName);
    await page.goto('/');
    await expect(page.locator('.top-bar')).toBeVisible();

    await page
      .locator('.top-bar-action', { hasText: '添加 VS Code 窗口' })
      .click();

    const captureCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: uniqueName }),
    });
    await expect(captureCard).toBeVisible({ timeout: 10000 });
    await expect(captureCard.locator('.grid-card-badge')).toHaveText('运行中');

    await page.waitForTimeout(12_000);

    await expect(captureCard.locator('.grid-card-badge')).toHaveText('空闲');
    await expect(captureCard).toHaveClass(/card-idle/);
  } finally {
    await cleanupCaptureSessions(request);
  }
});

test('window capture: 运行中和停止后都可以删除', async ({
  request,
}) => {
  await cleanupCaptureSessions(request);

  const createRes = await request.post('/api/agent-sessions/window-capture', {
    data: { suggestedDisplayName: 'E2E-delete-test' },
  });
  expect(createRes.ok()).toBeTruthy();

  const { agentSession } = await createRes.json();

  try {
    // DELETE should succeed even while running (auto-stops capture)
    const deleteRes = await request.delete(
      `/api/agent-sessions/${agentSession.id}`,
    );
    expect(deleteRes.status()).toBe(204);
  } catch {
    await request
      .delete(`/api/agent-sessions/${agentSession.id}`)
      .catch(() => {});
  }
});

test('window capture: 双击进入焦点态显示预览', async ({ page, request }) => {
  await cleanupCaptureSessions(request);
  const uniqueName = `VSCode-Focus-${Date.now()}`;

  try {
    await mockGetDisplayMedia(page, uniqueName);
    await page.goto('/');
    await expect(page.locator('.top-bar')).toBeVisible();

    await page
      .locator('.top-bar-action', { hasText: '添加 VS Code 窗口' })
      .click();

    const captureCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: uniqueName }),
    });
    await expect(captureCard).toBeVisible({ timeout: 10000 });

    await captureCard.dblclick();

    await expect(page.locator('.focus-main')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.focus-main-name')).toContainText(uniqueName);

    // Should have video or capture placeholder, NOT a terminal
    const hasVideo = await page
      .locator('.focus-main-terminal video.capture-video')
      .isVisible()
      .catch(() => false);
    const hasPlaceholder = await page
      .locator('.focus-main-terminal .capture-placeholder')
      .isVisible()
      .catch(() => false);
    expect(hasVideo || hasPlaceholder).toBeTruthy();

    await page.locator('.focus-exit-btn').click();
    await expect(page.locator('.focus-main')).not.toBeVisible();
  } finally {
    await cleanupCaptureSessions(request);
  }
});

test('window capture: 停止观察按钮生效', async ({ page, request }) => {
  await cleanupCaptureSessions(request);
  const uniqueName = `VSCode-Stop-${Date.now()}`;

  try {
    await mockGetDisplayMedia(page, uniqueName);
    await page.goto('/');
    await expect(page.locator('.top-bar')).toBeVisible();

    await page
      .locator('.top-bar-action', { hasText: '添加 VS Code 窗口' })
      .click();

    const captureCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: uniqueName }),
    });
    await expect(captureCard).toBeVisible({ timeout: 10000 });

    // Should show stop button
    const stopBtn = captureCard.locator('button', { hasText: '停止观察' });
    await expect(stopBtn).toBeVisible({ timeout: 5000 });

    // Click stop
    await stopBtn.click();

    // Wait for state transition - card should show exited badge
    await expect(
      captureCard.locator('.grid-card-badge', { hasText: '已退出' }),
    ).toBeVisible({ timeout: 10000 });

    // Now should be deletable via API
    const sessions = await request.get('/api/agent-sessions');
    const data = await sessions.json();
    const captureSession = data.items.find(
      (s: any) =>
        s.sourceType === 'local-window-capture' &&
        s.displayName === uniqueName,
    );
    if (captureSession) {
      const deleteRes = await request.delete(
        `/api/agent-sessions/${captureSession.id}`,
      );
      expect(deleteRes.status()).toBe(204);
    }
  } finally {
    await cleanupCaptureSessions(request);
  }
});

test('window capture: 可以手动重命名宫格且保留原始标签', async ({
  page,
  request,
}) => {
  await cleanupCaptureSessions(request);

  try {
    await mockGetDisplayMedia(page, 'window:57802:0');
    await page.goto('/');
    await expect(page.locator('.top-bar')).toBeVisible();

    await page
      .locator('.top-bar-action', { hasText: '添加 VS Code 窗口' })
      .click();

    const captureCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: 'window:57802:0' }),
    });
    await expect(captureCard).toBeVisible({ timeout: 10000 });

    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept('我的 VS Code 窗口');
    });

    await captureCard.locator('.grid-card-rename').click();

    const renamedCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: '我的 VS Code 窗口' }),
    });

    await expect(renamedCard).toBeVisible({ timeout: 10000 });
    await expect(renamedCard.locator('.grid-card-name')).toContainText(
      '我的 VS Code 窗口',
    );

    const sessions = await request.get('/api/agent-sessions');
    const data = await sessions.json();
    const renamedSession = data.items.find(
      (s: any) =>
        s.sourceType === 'local-window-capture' &&
        s.windowCaptureMeta?.rawLabel === 'window:57802:0',
    );

    expect(renamedSession).toBeTruthy();
    expect(renamedSession.displayName).toBe('我的 VS Code 窗口');
    expect(renamedSession.windowCaptureMeta.rawLabel).toBe('window:57802:0');
  } finally {
    await cleanupCaptureSessions(request);
  }
});
