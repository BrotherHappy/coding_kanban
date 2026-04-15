import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { resolveTmuxBinary } from './tmux-binary';

const TMUX_BINARY = resolveTmuxBinary();
const COPILOT_SESSION_ROOT = path.join(
  os.homedir(),
  '.copilot',
  'session-state',
);
const backendBaseUrl = process.env.PLAYWRIGHT_BACKEND_URL ?? '';

function backendPath(pathname: string): string {
  if (!backendBaseUrl) {
    return pathname;
  }

  return new URL(pathname, backendBaseUrl).toString();
}

function runTmux(args: string[]): string {
  return execFileSync(TMUX_BINARY, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync(TMUX_BINARY, ['kill-session', '-t', sessionName], {
      stdio: 'ignore',
    });
  } catch {
    // ignore cleanup failures
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getTmuxClientSize(
  sessionName: string,
): { cols: number; rows: number } | null {
  const output = runTmux([
    'list-clients',
    '-t',
    sessionName,
    '-F',
    '#{client_width}x#{client_height}',
  ]);
  const firstLine = output.split('\n').find(Boolean);

  if (!firstLine) {
    return null;
  }

  const match = firstLine.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    cols: Number(match[1]),
    rows: Number(match[2]),
  };
}

function runSshCommand(
  host: {
    host: string;
    port: number;
    username?: string;
    identityFile?: string;
  },
  remoteCommand: string,
): string {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];

  if (host.port) {
    args.push('-p', String(host.port));
  }

  if (host.identityFile) {
    args.push('-i', host.identityFile);
  }

  const userHost = host.username ? `${host.username}@${host.host}` : host.host;
  args.push(userHost, remoteCommand);

  return execFileSync('ssh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function killRemoteTmuxSession(
  host: {
    host: string;
    port: number;
    username?: string;
    identityFile?: string;
  },
  sessionName: string,
): void {
  try {
    runSshCommand(
      host,
      `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || true`,
    );
  } catch {
    // ignore cleanup failures
  }
}

function getRemoteTmuxClientSize(
  host: {
    host: string;
    port: number;
    username?: string;
    identityFile?: string;
  },
  sessionName: string,
): { cols: number; rows: number } | null {
  try {
    const output = runSshCommand(
      host,
      `tmux list-clients -t ${shellQuote(sessionName)} -F '#{client_width}x#{client_height}'`,
    );
    const firstLine = output.split('\n').find(Boolean);

    if (!firstLine) {
      return null;
    }

    const match = firstLine.match(/^(\d+)x(\d+)$/);
    if (!match) {
      return null;
    }

    return {
      cols: Number(match[1]),
      rows: Number(match[2]),
    };
  } catch {
    return null;
  }
}

function tmuxPaneContainsText(sessionName: string, text: string): boolean {
  try {
    return runTmux(['capture-pane', '-pt', sessionName]).includes(text);
  } catch {
    return false;
  }
}

async function waitForSessionInList(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(backendPath('/api/agent-sessions'));
      const payload = (await response.json()) as {
        items?: Array<{ id?: string }>;
      };

      return payload.items?.some((item) => item.id === sessionId) ?? false;
    })
    .toBeTruthy();
}

async function ensureGridMode(page: Page): Promise<void> {
  const exitButton = page.getByRole('button', { name: '返回宫格' });
  if ((await exitButton.count()) === 0) {
    return;
  }

  if (await exitButton.first().isVisible()) {
    await exitButton.first().click();
  }
}

async function getSshHosts(request: APIRequestContext): Promise<
  Array<{
    name: string;
    host: string;
    port: number;
    username?: string;
    identityFile?: string;
    defaultPath: string;
  }>
> {
  const response = await request.get(backendPath('/api/ssh-hosts'));
  expect(response.ok()).toBeTruthy();

  const payload = await response.json();
  return payload.hosts;
}

function createCopilotSessionState(options: {
  sessionId: string;
  sessionName: string;
  workingDirectory: string;
  running: boolean;
}): string {
  const sessionDir = path.join(COPILOT_SESSION_ROOT, options.sessionId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'workspace.yaml'),
    [
      `id: ${options.sessionId}`,
      `cwd: ${options.workingDirectory}`,
      `name: ${options.sessionName}`,
      `updated_at: ${new Date().toISOString()}`,
    ].join('\n'),
  );

  if (options.running) {
    fs.writeFileSync(path.join(sessionDir, `inuse.${process.pid}.lock`), '');
  }

  return sessionDir;
}

function removeCopilotSessionState(sessionId: string): void {
  fs.rmSync(path.join(COPILOT_SESSION_ROOT, sessionId), {
    recursive: true,
    force: true,
  });
}

async function findSessionByDisplayName(
  request: APIRequestContext,
  displayName: string,
) {
  const response = await request.get(backendPath('/api/agent-sessions'));
  if (!response.ok()) {
    return undefined;
  }

  const payload = await response.json();
  return payload.items.find(
    (item: {
      id: string;
      displayName: string;
      interactionState: string;
      transportRef?: { tmuxSession?: string };
    }) => item.displayName === displayName,
  ) as
    | {
        id: string;
        displayName: string;
        interactionState: string;
        transportRef?: { tmuxSession?: string };
      }
    | undefined;
}

async function findSessionsByDisplayName(
  request: APIRequestContext,
  displayName: string,
) {
  const response = await request.get(backendPath('/api/agent-sessions'));
  if (!response.ok()) {
    return [];
  }

  const payload = await response.json();
  return payload.items.filter(
    (item: {
      id: string;
      displayName: string;
      interactionState: string;
      transportRef?: { tmuxSession?: string };
      agentSessionId?: string;
    }) => item.displayName === displayName,
  ) as Array<{
    id: string;
    displayName: string;
    interactionState: string;
    transportRef?: { tmuxSession?: string };
    agentSessionId?: string;
  }>;
}

async function deleteSessionIfPresent(
  request: APIRequestContext,
  displayName: string,
): Promise<void> {
  const session = await findSessionByDisplayName(request, displayName);
  if (session) {
    await request.delete(backendPath(`/api/agent-sessions/${session.id}`));
  }
}

async function getSessionOutputEntries(
  request: APIRequestContext,
  agentSessionId: string,
): Promise<string[]> {
  const response = await request.get(
    backendPath(`/api/agent-sessions/${agentSessionId}`),
  );
  expect(response.ok()).toBeTruthy();

  const payload = await response.json();
  return payload.outputEntries.map((entry: { text: string }) => entry.text);
}

async function getLastReportedTtySize(
  request: APIRequestContext,
  agentSessionId: string,
): Promise<{ rows: number; cols: number } | null> {
  const entries = await getSessionOutputEntries(request, agentSessionId);
  const text = entries.join('');
  const matches = [...text.matchAll(/tty-size:(\d+)x(\d+)/g)];
  const last = matches.at(-1);

  if (!last) {
    return null;
  }

  return {
    rows: Number(last[1]),
    cols: Number(last[2]),
  };
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sentFrames: string[] = [];
    (
      window as typeof window & { __terminalMouseFrames?: string[] }
    ).__terminalMouseFrames = sentFrames;

    const originalSend = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function patchedSend(data: unknown) {
      if (typeof data === 'string' && !data.includes('"type":"resize"')) {
        sentFrames.push(data);
      }

      return originalSend.call(this, data);
    };
  });
}

test('browser: 普通对话终端可以用鼠标滚轮浏览历史', async ({
  page,
  request,
}) => {
  const displayName = `E2E Scroll ${Date.now()}`;
  let sessionId: string | undefined;

  try {
    await page.setViewportSize({ width: 1600, height: 1200 });

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: 'node ./scripts/mock-terminal-agent.mjs scroll',
          workingDirectory: process.cwd(),
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    sessionId = (await launchResponse.json()).id;

    await page.goto('/');

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.dblclick();

    const viewport = page.locator('.focus-main .xterm-viewport');
    await expect(viewport).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const terminal = document.querySelector(
            '.focus-main .terminal-view',
          ) as
            | (HTMLDivElement & {
                __xterm?: {
                  buffer?: { active?: { viewportY?: number } };
                };
              })
            | null;

          return terminal?.__xterm?.buffer?.active?.viewportY ?? 0;
        }),
      )
      .toBeGreaterThan(0);

    const before = await page.evaluate(() => {
      const terminal = document.querySelector('.focus-main .terminal-view') as
        | (HTMLDivElement & {
            __xterm?: {
              buffer?: { active?: { viewportY?: number } };
            };
          })
        | null;

      return terminal?.__xterm?.buffer?.active?.viewportY ?? 0;
    });
    await page.locator('.focus-main .terminal-view').hover();
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const terminal = document.querySelector('.focus-main .terminal-view') as
        | (HTMLDivElement & {
            __xterm?: {
              buffer?: { active?: { viewportY?: number } };
            };
          })
        | null;

      return terminal?.__xterm?.buffer?.active?.viewportY ?? 0;
    });

    expect(after).toBeLessThan(before);
  } finally {
    if (sessionId) {
      await request.delete(backendPath(`/api/agent-sessions/${sessionId}`));
    }
  }
});

test('browser: 调整窗口大小会把新的终端尺寸同步到 PTY', async ({
  page,
  request,
}) => {
  const displayName = `E2E Initial Resize ${Date.now()}`;
  let sessionId: string | undefined;

  try {
    await page.setViewportSize({ width: 1280, height: 820 });

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: 'node ./scripts/mock-terminal-agent.mjs size',
          workingDirectory: process.cwd(),
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    sessionId = (await launchResponse.json()).id;

    await page.goto('/');

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.dblclick();
    await page.waitForTimeout(1200);

    await expect
      .poll(() => getLastReportedTtySize(request, sessionId!), {
        timeout: 15000,
      })
      .not.toBeNull();

    const initialSize = await getLastReportedTtySize(request, sessionId!);
    expect(initialSize).not.toBeNull();

    await page.setViewportSize({ width: 1600, height: 1200 });

    await expect
      .poll(
        async () => {
          const size = await getLastReportedTtySize(request, sessionId!);
          if (!size || !initialSize) {
            return null;
          }

          return size.cols > initialSize.cols || size.rows > initialSize.rows
            ? size
            : null;
        },
        {
          timeout: 15000,
        },
      )
      .not.toBeNull();

    const resizedSize = await getLastReportedTtySize(request, sessionId!);

    expect(initialSize).not.toBeNull();
    expect(resizedSize).not.toBeNull();
    expect(resizedSize!.rows).toBeGreaterThanOrEqual(initialSize!.rows);
    expect(resizedSize!.cols).toBeGreaterThan(initialSize!.cols);
  } finally {
    if (sessionId) {
      await request.delete(backendPath(`/api/agent-sessions/${sessionId}`));
    }
  }
});

test('browser: tmux 缩略图不会把真实终端缩回小尺寸', async ({
  page,
  request,
}) => {
  const sessionName = `e2e-thumbnail-${Date.now()}`;
  const displayName = `E2E Thumbnail Tmux ${Date.now()}`;

  let launchedSessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      'bash',
    ]);

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: `tmux attach -t '${sessionName}'`,
          workingDirectory: process.cwd(),
          tmuxSessionName: sessionName,
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    launchedSessionId = (await launchResponse.json()).id;

    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.goto('/');

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.dblclick();

    await expect
      .poll(() => getTmuxClientSize(sessionName), {
        timeout: 15000,
      })
      .not.toBeNull();

    await page.waitForTimeout(1200);

    const focusedSize = getTmuxClientSize(sessionName);
    expect(focusedSize).not.toBeNull();

    await page.getByRole('button', { name: '返回宫格' }).click();
    await expect(card).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);

    const gridSize = getTmuxClientSize(sessionName);
    expect(gridSize).not.toBeNull();
    expect(gridSize).toEqual(focusedSize);
  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }
    killTmuxSession(sessionName);
  }
});

test('browser: tmux 终端会转发鼠标二进制事件', async ({ page, request }) => {
  const sessionName = `e2e-mouse-${Date.now()}`;
  const displayName = `E2E Mouse Tmux ${Date.now()}`;

  let launchedSessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      'node ./scripts/mock-terminal-agent.mjs mouse',
    ]);

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: `tmux attach -t '${sessionName}'`,
          workingDirectory: process.cwd(),
          tmuxSessionName: sessionName,
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    launchedSessionId = (await launchResponse.json()).id;

    await installWebSocketSpy(page);
    await page.goto('/');

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('.grid-card-tag')).toHaveText('tmux');

    await card.dblclick();
    const terminal = page.locator('.focus-main .terminal-view');
    const screen = page.locator('.focus-main .terminal-view .xterm-screen');
    await expect(terminal).toBeVisible({ timeout: 15000 });
    await expect(screen).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const terminal = document.querySelector(
            '.focus-main .terminal-view',
          ) as
            | (HTMLDivElement & {
                __xterm?: {
                  modes?: {
                    mouseTrackingMode?: string;
                  };
                  options?: {
                    disableStdin?: boolean;
                  };
                };
              })
            | null;

          return {
            mouseTrackingMode:
              terminal?.__xterm?.modes?.mouseTrackingMode ?? 'none',
            disableStdin: terminal?.__xterm?.options?.disableStdin ?? null,
          };
        }),
      )
      .toMatchObject({
        disableStdin: false,
      });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const terminal = document.querySelector(
            '.focus-main .terminal-view',
          ) as
            | (HTMLDivElement & {
                __xterm?: {
                  modes?: {
                    mouseTrackingMode?: string;
                  };
                };
              })
            | null;

          return terminal?.__xterm?.modes?.mouseTrackingMode ?? 'none';
        }),
      )
      .not.toBe('none');

    const before = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalMouseFrames?: string[];
          }
        ).__terminalMouseFrames?.length ?? 0,
    );

    await screen.click({ position: { x: 80, y: 40 } });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __terminalMouseFrames?: string[];
              }
            ).__terminalMouseFrames?.length ?? 0,
        ),
      )
      .toBeGreaterThan(before);

    const afterClick = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalMouseFrames?: string[];
          }
        ).__terminalMouseFrames?.length ?? 0,
    );

    await page.mouse.wheel(0, -300);

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __terminalMouseFrames?: string[];
              }
            ).__terminalMouseFrames?.length ?? 0,
        ),
      )
      .toBeGreaterThan(afterClick);

    const frames = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalMouseFrames?: string[];
          }
        ).__terminalMouseFrames ?? [],
    );
    expect(
      frames.some(
        (frame) =>
          frame.includes('"type":"binary"') ||
          frame.includes('\u001b') ||
          frame.includes('[M'),
      ),
    ).toBeTruthy();

  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }
    killTmuxSession(sessionName);
  }
});

test('browser: 切回浏览器窗口后会恢复 tmux 输入焦点', async ({
  page,
  request,
}) => {
  const sessionName = `e2e-mouse-window-refocus-${Date.now()}`;
  const displayName = `E2E Mouse Window Refocus ${Date.now()}`;

  let launchedSessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      'node ./scripts/mock-terminal-agent.mjs mouse',
    ]);

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: `tmux attach -t '${sessionName}'`,
          workingDirectory: process.cwd(),
          tmuxSessionName: sessionName,
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    launchedSessionId = (await launchResponse.json()).id;
    await waitForSessionInList(request, launchedSessionId);

    await installWebSocketSpy(page);
    await page.goto('/');
    await ensureGridMode(page);

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.dblclick();

    const terminal = page.locator('.focus-main .terminal-view');
    const screen = page.locator('.focus-main .terminal-view .xterm-screen');
    await expect(terminal).toBeVisible({ timeout: 15000 });
    await expect(screen).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => tmuxPaneContainsText(sessionName, 'mouse-ready'))
      .toBeTruthy();
    await page.waitForTimeout(150);

    await screen.click({ position: { x: 90, y: 50 } });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document.activeElement?.classList.contains(
              'xterm-helper-textarea',
            ) ?? false,
        ),
      )
      .toBeTruthy();

    const backgroundPage = await page.context().newPage();
    await backgroundPage.goto('about:blank');
    await backgroundPage.bringToFront();
    await page.bringToFront();
    await backgroundPage.close();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document.activeElement?.classList.contains(
              'xterm-helper-textarea',
            ) ?? false,
        ),
      )
      .toBeTruthy();
  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }
    killTmuxSession(sessionName);
  }
});

test('browser: 频繁切换宫格后 tmux 终端仍会转发鼠标二进制事件', async ({
  page,
  request,
}) => {
  const sessionName = `e2e-mouse-grid-refocus-${Date.now()}`;
  const displayName = `E2E Mouse Grid Refocus ${Date.now()}`;

  let launchedSessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      'node ./scripts/mock-terminal-agent.mjs mouse',
    ]);

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: `tmux attach -t '${sessionName}'`,
          workingDirectory: process.cwd(),
          tmuxSessionName: sessionName,
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    launchedSessionId = (await launchResponse.json()).id;
    await waitForSessionInList(request, launchedSessionId);

    await installWebSocketSpy(page);
    await page.goto('/');
    await ensureGridMode(page);

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    for (let index = 0; index < 3; index += 1) {
      await card.dblclick();
      await expect(page.locator('.focus-main .terminal-view')).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('button', { name: '返回宫格' }).click();
      await expect(card).toBeVisible({ timeout: 15000 });
    }

    await card.dblclick();

    const terminal = page.locator('.focus-main .terminal-view');
    const screen = page.locator('.focus-main .terminal-view .xterm-screen');
    await expect(terminal).toBeVisible({ timeout: 15000 });
    await expect(screen).toBeVisible({ timeout: 15000 });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const terminal = document.querySelector(
            '.focus-main .terminal-view',
          ) as
            | (HTMLDivElement & {
                __xterm?: {
                  modes?: {
                    mouseTrackingMode?: string;
                  };
                };
              })
            | null;

          return terminal?.__xterm?.modes?.mouseTrackingMode ?? 'none';
        }),
      )
      .not.toBe('none');

    const before = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalMouseFrames?: string[];
          }
        ).__terminalMouseFrames?.length ?? 0,
    );

    await screen.click({ position: { x: 80, y: 40 } });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __terminalMouseFrames?: string[];
              }
            ).__terminalMouseFrames?.length ?? 0,
        ),
      )
      .toBeGreaterThan(before);
  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }
    killTmuxSession(sessionName);
  }
});

test('browser: 切回宫格后重新进入 tmux 时第一次点击不会丢失', async ({
  page,
  request,
}) => {
  const sessionName = `e2e-mouse-first-click-${Date.now()}`;
  const displayName = `E2E Mouse First Click ${Date.now()}`;

  let launchedSessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      'node ./scripts/mock-terminal-agent.mjs mouse',
    ]);

    const launchResponse = await request.post(
      backendPath('/api/agent-launch/pty'),
      {
        data: {
          workspaceId: 'default',
          displayName,
          agentKind: 'copilot',
          command: `tmux attach -t '${sessionName}'`,
          workingDirectory: process.cwd(),
          tmuxSessionName: sessionName,
        },
      },
    );

    expect(launchResponse.ok()).toBeTruthy();
    launchedSessionId = (await launchResponse.json()).id;
    await waitForSessionInList(request, launchedSessionId);

    await installWebSocketSpy(page);
    await page.goto('/');
    await ensureGridMode(page);

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.dblclick();
    await expect(page.locator('.focus-main .terminal-view')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: '返回宫格' }).click();
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.dblclick();

    const screen = page.locator('.focus-main .terminal-view .xterm-screen');
    await expect(screen).toBeVisible({ timeout: 15000 });

    const before = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalMouseFrames?: string[];
          }
        ).__terminalMouseFrames?.length ?? 0,
    );

    await screen.click({ position: { x: 80, y: 40 } });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __terminalMouseFrames?: string[];
              }
            ).__terminalMouseFrames?.length ?? 0,
        ),
        {
          timeout: 1000,
        },
      )
      .toBeGreaterThan(before);
  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }
    killTmuxSession(sessionName);
  }
});

test('browser: Ctrl/Meta+E 可以快速连接远端 tmux 并自动聚焦', async ({
  page,
  request,
}) => {
  const sshHosts = await getSshHosts(request);
  const remoteHost =
    sshHosts.find((host) => host.name === 'hm20') ??
    sshHosts.find((host) => host.name === 'hm24');

  test.skip(!remoteHost, 'requires hm20 or hm24 ssh preset');

  const sessionName = `quick-e2e-${Date.now()}`;
  const workingDirectory = '~/';
  const marker = `REMOTE_TMUX_OK_${Date.now()}`;
  let launchedSessionId: string | undefined;

  killRemoteTmuxSession(remoteHost!, sessionName);

  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /快速连接 tmux/ }),
    ).toBeVisible();

    await page.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'e',
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    await expect(page.getByTestId('quick-tmux-connect-dialog')).toBeVisible();

    const hostSearch = page.getByTestId('quick-tmux-host-search');
    await hostSearch.fill(remoteHost!.name);
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('quick-tmux-session-name')).toBeVisible();
    await page.getByTestId('quick-tmux-session-name').fill(sessionName);
    await page
      .getByTestId('quick-tmux-working-directory')
      .fill(workingDirectory);
    await page.getByRole('button', { name: '打开 tmux' }).click();

    await expect(page.locator('.focus-main-name')).toHaveText(sessionName, {
      timeout: 15000,
    });

    await expect
      .poll(async () => findSessionByDisplayName(request, sessionName), {
        timeout: 15000,
      })
      .toMatchObject({
        displayName: sessionName,
        transportRef: {
          tmuxSession: sessionName,
        },
      });

    launchedSessionId = (await findSessionByDisplayName(request, sessionName))
      ?.id;

    await expect
      .poll(() => getRemoteTmuxClientSize(remoteHost!, sessionName), {
        timeout: 15000,
      })
      .not.toBeNull();

    const remoteSize = getRemoteTmuxClientSize(remoteHost!, sessionName);
    expect(remoteSize).not.toBeNull();
    expect(remoteSize!.cols).toBeGreaterThanOrEqual(120);
    expect(remoteSize!.rows).toBeGreaterThanOrEqual(35);

    const remoteActiveBorderStyle = runSshCommand(
      remoteHost!,
      `tmux show-window-options -vt ${shellQuote(sessionName)} pane-active-border-style 2>/dev/null || true`,
    ).trim();
    expect(remoteActiveBorderStyle).not.toContain("#00afff");
    expect(remoteActiveBorderStyle).not.toContain("fg=#00afff");

    await page.locator('.focus-main-terminal .xterm-screen').click();
    await page.keyboard.type(`printf '${marker}\\n'`);
    await page.keyboard.press('Enter');

    await expect
      .poll(() => {
        try {
          return runSshCommand(
            remoteHost!,
            `tmux capture-pane -pt ${shellQuote(sessionName)}`,
          );
        } catch {
          return '';
        }
      })
      .toContain(marker);

    await page.getByRole('button', { name: '返回宫格' }).click();

    const card = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: sessionName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('.grid-card-tag')).toHaveText('tmux');
  } finally {
    if (launchedSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${launchedSessionId}`),
      );
    }

    if (remoteHost) {
      killRemoteTmuxSession(remoteHost, sessionName);
    }
  }
});

test('browser: 扫描结果会合并 tmux 运行态并支持 tmux 恢复', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const runningSessionId = `e2e-running-${Date.now()}`;
  const runningSessionName = `e2e-running-tmux-${Date.now()}`;
  const stoppedSessionId = `e2e-stopped-${Date.now()}`;
  const stoppedSessionName = `e2e-stopped-tmux-${Date.now()}`;
  const scanDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `tmux-scan-e2e-${Date.now()}-`),
  );

  killTmuxSession(runningSessionName);
  killTmuxSession(stoppedSessionName);

  createCopilotSessionState({
    sessionId: runningSessionId,
    sessionName: runningSessionName,
    workingDirectory: scanDirectory,
    running: true,
  });
  createCopilotSessionState({
    sessionId: stoppedSessionId,
    sessionName: stoppedSessionName,
    workingDirectory: scanDirectory,
    running: false,
  });

  let attachedRunningId: string | undefined;
  let resumedStoppedId: string | undefined;

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      runningSessionName,
      '-c',
      scanDirectory,
      'sleep 120',
    ]);

    await page.goto('/');

    await page.getByText('扫描会话').click();
    await page.locator('.host-dropdown-item', { hasText: '本机' }).click();

    await expect(page.locator('.discovery-dialog-title')).toContainText(
      '发现会话',
    );

    const dialog = page.locator('.discovery-dialog');
    await dialog.locator('.discovery-path-input').fill(scanDirectory);
    await dialog.locator('.discovery-scan-btn').click();

    await expect(page.locator('.discovery-list')).toBeVisible({
      timeout: 15000,
    });

    const scanStyles = await page
      .locator('.discovery-list')
      .evaluate((element) => {
        const styles = window.getComputedStyle(element);
        return {
          overflowY: styles.overflowY,
        };
      });

    expect(scanStyles.overflowY).toBe('auto');

    const runningItem = dialog
      .locator('.discovery-item')
      .filter({ hasText: runningSessionName });
    await expect(runningItem).toContainText('copilot');
    await expect(runningItem).toContainText('tmux');
    await runningItem.getByRole('button', { name: '从 tmux 加入宫格' }).click();

    await expect
      .poll(async () => findSessionByDisplayName(request, runningSessionName), {
        timeout: 15000,
      })
      .toMatchObject({
        displayName: runningSessionName,
        transportRef: {
          tmuxSession: runningSessionName,
        },
      });

    attachedRunningId = (
      await findSessionByDisplayName(request, runningSessionName)
    )?.id;

    const runningCard = page.locator('.grid-card', {
      has: page.locator('.grid-card-name', { hasText: runningSessionName }),
    });
    await expect(runningCard).toBeVisible({ timeout: 15000 });
    await expect(runningCard.locator('.grid-card-tag')).toHaveText('tmux');

    const stoppedItem = dialog
      .locator('.discovery-item')
      .filter({ hasText: stoppedSessionName });
    await expect(stoppedItem).toContainText('已停止', { timeout: 15000 });
    await expect(stoppedItem.locator('.discovery-add-btn')).toBeVisible({
      timeout: 15000,
    });
    await stoppedItem.locator('.discovery-add-btn').click();

    await expect
      .poll(async () => findSessionByDisplayName(request, stoppedSessionName), {
        timeout: 15000,
      })
      .toMatchObject({
        displayName: stoppedSessionName,
      });

    resumedStoppedId = (
      await findSessionByDisplayName(request, stoppedSessionName)
    )?.id;
  } finally {
    if (attachedRunningId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${attachedRunningId}`),
      );
    }
    if (resumedStoppedId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${resumedStoppedId}`),
      );
    }

    await deleteSessionIfPresent(request, runningSessionName);
    await deleteSessionIfPresent(request, stoppedSessionName);
    removeCopilotSessionState(runningSessionId);
    removeCopilotSessionState(stoppedSessionId);
    killTmuxSession(runningSessionName);
    killTmuxSession(stoppedSessionName);
    fs.rmSync(scanDirectory, { recursive: true, force: true });
  }
});

test('browser: 扫描应用中的 tmux 结果同时支持直接加入和从 tmux 加入', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const runningSessionId = `e2e-app-running-${Date.now()}`;
  const runningSessionName = `e2e-app-running-tmux-${Date.now()}`;
  const scanDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `app-scan-e2e-${Date.now()}-`),
  );

  killTmuxSession(runningSessionName);

  createCopilotSessionState({
    sessionId: runningSessionId,
    sessionName: runningSessionName,
    workingDirectory: scanDirectory,
    running: true,
  });

  let directSessionId: string | undefined;
  let tmuxSessionId: string | undefined;

  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      runningSessionName,
      '-c',
      scanDirectory,
      'sleep 120',
    ]);

    await page.goto('/');

    await page.getByText('扫描会话').click();
    await page.locator('.host-dropdown-item', { hasText: '本机' }).click();

    const dialog = page.locator('.discovery-dialog');
    await expect(page.locator('.discovery-dialog-title')).toContainText(
      '发现会话',
    );

    await dialog.locator('.discovery-path-input').fill(scanDirectory);
    await dialog.locator('.discovery-scan-btn').click();

    const runningItem = dialog
      .locator('.discovery-item')
      .filter({ hasText: runningSessionName });

    await expect(runningItem).toContainText('copilot');
    await expect(runningItem).toContainText('tmux');
    await expect(
      runningItem.getByRole('button', { name: '加入宫格', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      runningItem.getByRole('button', { name: '从 tmux 加入宫格' }),
    ).toBeVisible({ timeout: 15000 });

    await runningItem
      .getByRole('button', { name: '加入宫格', exact: true })
      .click();

    await expect
      .poll(
        async () =>
          (await findSessionsByDisplayName(request, runningSessionName)).some(
            (session) => !session.transportRef?.tmuxSession,
          ),
        {
          timeout: 15000,
        },
      )
      .toBe(true);

    directSessionId = (
      await findSessionsByDisplayName(request, runningSessionName)
    ).find((session) => !session.transportRef?.tmuxSession)?.id;

    expect(directSessionId).toBeTruthy();

    await runningItem.getByRole('button', { name: '从 tmux 加入宫格' }).click();

    await expect
      .poll(
        async () =>
          (await findSessionsByDisplayName(request, runningSessionName)).some(
            (session) =>
              session.transportRef?.tmuxSession === runningSessionName,
          ),
        {
          timeout: 15000,
        },
      )
      .toBe(true);

    tmuxSessionId = (
      await findSessionsByDisplayName(request, runningSessionName)
    ).find(
      (session) => session.transportRef?.tmuxSession === runningSessionName,
    )?.id;

    expect(tmuxSessionId).toBeTruthy();
  } finally {
    if (directSessionId) {
      await request.delete(
        backendPath(`/api/agent-sessions/${directSessionId}`),
      );
    }
    if (tmuxSessionId) {
      await request.delete(backendPath(`/api/agent-sessions/${tmuxSessionId}`));
    }

    await deleteSessionIfPresent(request, runningSessionName);
    removeCopilotSessionState(runningSessionId);
    killTmuxSession(runningSessionName);
    fs.rmSync(scanDirectory, { recursive: true, force: true });
  }
});
