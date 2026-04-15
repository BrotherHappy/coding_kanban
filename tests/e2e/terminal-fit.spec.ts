import { execFileSync } from "node:child_process";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { resolveTmuxBinary } from "./tmux-binary";

declare const process: {
  cwd(): string;
};

const TMUX_BINARY = resolveTmuxBinary();

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

test("browser: 聚焦态 tmux 终端的底部渲染不会超出可视容器", async ({
  page,
  request,
}) => {
  const sessionName = `e2e-fit-${Date.now()}`;
  const displayName = `E2E Fit ${Date.now()}`;
  let sessionId: string | undefined;

  killTmuxSession(sessionName);

  try {
    execFileSync(
      TMUX_BINARY,
      [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        process.cwd(),
        "sh",
        "-lc",
        "printf 'fit-check-ready\\n'; sleep 30",
      ],
      { stdio: "ignore" },
    );

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

    const terminalContainer = page.locator(".focus-main-terminal");
    const terminalScreen = page.locator(".focus-main-terminal .xterm-screen");

    await expect(terminalScreen).toBeVisible({ timeout: 15000 });

    const containerBox = await terminalContainer.boundingBox();
    const screenBox = await terminalScreen.boundingBox();

    expect(containerBox).not.toBeNull();
    expect(screenBox).not.toBeNull();
    expect(screenBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 2);
    expect(screenBox!.y + screenBox!.height).toBeLessThanOrEqual(
      containerBox!.y + containerBox!.height + 2,
    );
  } finally {
    await deleteSessionIfPresent(request, sessionId);
    killTmuxSession(sessionName);
  }
});
