import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCopilotBinary } from "./copilot-binary.js";

function writeExecutable(filePath: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

test("resolveCopilotBinary prefers the binary next to the current node runtime", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "copilot-bin-"));
  const nodeBinDir = join(tempRoot, "node-bin");
  const playwrightBinDir = join(tempRoot, ".playwright-bin");
  const homeDir = join(tempRoot, "home");
  const localBinDir = join(homeDir, ".local", "bin");

  mkdirSync(nodeBinDir, { recursive: true });
  mkdirSync(playwrightBinDir, { recursive: true });
  mkdirSync(localBinDir, { recursive: true });

  const nodeExecPath = join(nodeBinDir, "node");
  const realCopilot = join(nodeBinDir, "copilot");
  const fakePlaywrightCopilot = join(playwrightBinDir, "copilot");
  const wrapperCopilot = join(localBinDir, "copilot");

  writeExecutable(nodeExecPath);
  writeExecutable(realCopilot);
  writeExecutable(fakePlaywrightCopilot);
  writeExecutable(wrapperCopilot);

  const resolved = resolveCopilotBinary(
    {
      HOME: homeDir,
      PATH: [playwrightBinDir, localBinDir, nodeBinDir].join(":"),
    },
    nodeExecPath,
  );

  assert.equal(resolved, realCopilot);
});

test("resolveCopilotBinary prefers the Playwright shim when the test env opts in", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "copilot-bin-"));
  const nodeBinDir = join(tempRoot, "node-bin");
  const playwrightBinDir = join(tempRoot, ".playwright-bin");

  mkdirSync(nodeBinDir, { recursive: true });
  mkdirSync(playwrightBinDir, { recursive: true });

  const nodeExecPath = join(nodeBinDir, "node");
  const realCopilot = join(nodeBinDir, "copilot");
  const fakePlaywrightCopilot = join(playwrightBinDir, "copilot");

  writeExecutable(nodeExecPath);
  writeExecutable(realCopilot);
  writeExecutable(fakePlaywrightCopilot);

  const resolved = resolveCopilotBinary(
    {
      PATH: [playwrightBinDir, nodeBinDir].join(":"),
      PLAYWRIGHT_USE_MOCK_COPILOT: "1",
    },
    nodeExecPath,
  );

  assert.equal(resolved, fakePlaywrightCopilot);
});

test("resolveCopilotBinary falls back to the first PATH match when no preferred candidate exists", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "copilot-bin-"));
  const firstBinDir = join(tempRoot, "first-bin");
  const secondBinDir = join(tempRoot, "second-bin");
  const nodeExecPath = join(tempRoot, "node-only", "node");

  mkdirSync(firstBinDir, { recursive: true });
  mkdirSync(secondBinDir, { recursive: true });
  mkdirSync(join(tempRoot, "node-only"), { recursive: true });

  const firstCopilot = join(firstBinDir, "copilot");
  const secondCopilot = join(secondBinDir, "copilot");

  writeExecutable(nodeExecPath);
  writeExecutable(firstCopilot);
  writeExecutable(secondCopilot);

  const resolved = resolveCopilotBinary(
    {
      PATH: [firstBinDir, secondBinDir].join(":"),
    },
    nodeExecPath,
  );

  assert.equal(resolved, firstCopilot);
});
