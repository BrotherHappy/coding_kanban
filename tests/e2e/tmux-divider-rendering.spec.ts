import { execFileSync } from "node:child_process";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { resolveTmuxBinary } from "./tmux-binary";

declare const process: {
  cwd(): string;
};

const TMUX_BINARY = resolveTmuxBinary();

function runTmux(args: string[]): string {
  return execFileSync(TMUX_BINARY, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync(TMUX_BINARY, ["kill-session", "-t", sessionName], {
      stdio: "ignore",
    });
  } catch {
    // ignore cleanup failures
  }
}

async function launchTmuxAttachSession(
  request: APIRequestContext,
  displayName: string,
  sessionName: string,
): Promise<string> {
  const response = await request.post("/api/agent-launch/pty", {
    data: {
      workspaceId: "default",
      displayName,
      agentKind: "copilot",
      command: `tmux attach -t '${sessionName}'`,
      workingDirectory: process.cwd(),
      tmuxSessionName: sessionName,
    },
  });

  expect(response.ok()).toBeTruthy();
  return (await response.json()).id;
}

async function deleteSessionIfPresent(
  request: APIRequestContext,
  agentSessionId?: string,
): Promise<void> {
  if (!agentSessionId) {
    return;
  }

  await request.delete(`/api/agent-sessions/${agentSessionId}`);
}

test("browser: tmux 分割布局切换到兼容的 glyph 渲染配置", async ({
  page,
  request,
}) => {
  const sessionName = `e2e-divider-${Date.now()}`;
  const displayName = `E2E Divider ${Date.now()}`;
  let sessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    runTmux([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      process.cwd(),
      "sh",
      "-lc",
      "printf 'left-pane\\n'; sleep 30",
    ]);
    runTmux([
      "split-window",
      "-h",
      "-t",
      sessionName,
      "-c",
      process.cwd(),
      "sh",
      "-lc",
      "printf 'right-pane\\n'; sleep 30",
    ]);

    sessionId = await launchTmuxAttachSession(request, displayName, sessionName);

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/");

    const card = page.locator(".grid-card", {
      has: page.locator(".grid-card-name", { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.dblclick();
    await expect(page.locator(".focus-main-name")).toContainText(displayName);
    await page.waitForTimeout(1200);

    await expect(
      page.locator(".focus-main-terminal .xterm-screen"),
    ).toBeVisible({ timeout: 15000 });

    const terminalOptions = await page.evaluate(() => {
      const terminal = document.querySelector(
        ".focus-main-terminal .terminal-view",
      ) as
        | (HTMLDivElement & {
            __xterm?: {
              options?: {
                customGlyphs?: boolean;
                rescaleOverlappingGlyphs?: boolean;
                lineHeight?: number;
                letterSpacing?: number;
              };
            };
          })
        | null;

      return terminal?.__xterm?.options
        ? {
            customGlyphs: terminal.__xterm.options.customGlyphs ?? null,
            rescaleOverlappingGlyphs:
              terminal.__xterm.options.rescaleOverlappingGlyphs ?? null,
            lineHeight: terminal.__xterm.options.lineHeight ?? null,
            letterSpacing: terminal.__xterm.options.letterSpacing ?? null,
          }
        : null;
    });

    expect(terminalOptions).not.toBeNull();
    expect(terminalOptions!.customGlyphs).toBe(false);
    expect(terminalOptions!.rescaleOverlappingGlyphs).toBe(false);
    expect(terminalOptions!.lineHeight).toBe(1);
    expect(terminalOptions!.letterSpacing).toBe(0);
  } finally {
    await deleteSessionIfPresent(request, sessionId);
    killTmuxSession(sessionName);
  }
});
