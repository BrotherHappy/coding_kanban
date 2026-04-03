import { expect, test, type APIRequestContext } from "@playwright/test";

declare const process: {
  cwd(): string;
};

async function launchMockSession(
  request: APIRequestContext,
  displayName: string,
): Promise<string> {
  const response = await request.post("/api/agent-launch/pty", {
    data: {
      workspaceId: "default",
      displayName,
      agentKind: "copilot",
      command: "node ./scripts/mock-terminal-agent.mjs scroll",
      workingDirectory: process.cwd(),
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

async function readFirstTerminalFontSize(page: import("@playwright/test").Page) {
  return await page.evaluate(() => {
    const terminal = document.querySelector(".grid-card .terminal-view") as
      | (HTMLDivElement & {
          __xterm?: {
            options?: {
              fontSize?: number;
            };
          };
        })
      | null;

    return terminal?.__xterm?.options?.fontSize ?? null;
  });
}

test("browser: 终端字号设置会立即生效并在刷新后保留", async ({
  page,
  request,
}) => {
  const displayName = `终端字号-${Date.now()}`;
  let sessionId: string | undefined;

  try {
    sessionId = await launchMockSession(request, displayName);

    await page.goto("/");

    const card = page.locator(".grid-card", {
      has: page.locator(".grid-card-name", { hasText: displayName }),
    });
    await expect(card).toBeVisible({ timeout: 15000 });

    await expect
      .poll(() => readFirstTerminalFontSize(page), { timeout: 10000 })
      .toBe(14);

    const slider = page.getByTestId("terminal-font-size-slider");
    await slider.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "12";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect(page.getByTestId("terminal-font-size-value")).toHaveText(
      "12px",
    );
    await expect
      .poll(() => readFirstTerminalFontSize(page), { timeout: 10000 })
      .toBe(12);

    await page.reload();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("terminal-font-size-value")).toHaveText(
      "12px",
    );
    await expect
      .poll(() => readFirstTerminalFontSize(page), { timeout: 10000 })
      .toBe(12);
  } finally {
    await deleteSessionIfPresent(request, sessionId);
  }
});
