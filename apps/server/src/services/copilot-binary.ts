import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, normalize } from "node:path";

function isExecutablePath(
  commandPath: string | undefined,
): commandPath is string {
  if (!commandPath || !commandPath.includes("/")) {
    return false;
  }

  try {
    accessSync(commandPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listCommandMatches(
  command: string,
  envPath: string | undefined,
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const directory of (envPath ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (!isExecutablePath(candidate)) {
      continue;
    }

    const normalized = normalize(candidate);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(candidate);
  }

  return results;
}

function scoreCandidate(
  candidate: string,
  env: NodeJS.ProcessEnv,
  nodeExecPath: string,
): number {
  let score = 0;
  const normalized = normalize(candidate);
  const nodeSibling = normalize(join(dirname(nodeExecPath), "copilot"));
  const home = env.HOME?.trim();

  if (normalized === nodeSibling) {
    score += 100;
  }

  if (env.NVM_BIN) {
    const nvmSibling = normalize(join(env.NVM_BIN, "copilot"));
    if (normalized === nvmSibling) {
      score += 80;
    }
  }

  if (normalized.includes(normalize("/.nvm/versions/node/"))) {
    score += 40;
  }

  if (normalized.includes(normalize("/.playwright-bin/"))) {
    score += env.PLAYWRIGHT_USE_MOCK_COPILOT === "1" ? 120 : -100;
  }

  if (home) {
    const wrapperPath = normalize(join(home, ".local", "bin", "copilot"));
    if (normalized === wrapperPath) {
      score -= 50;
    }
  }

  return score;
}

export function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  nodeExecPath = process.execPath,
): string | undefined {
  const candidates = [
    join(dirname(nodeExecPath), "copilot"),
    ...(env.NVM_BIN ? [join(env.NVM_BIN, "copilot")] : []),
    ...listCommandMatches("copilot", env.PATH),
  ].filter(isExecutablePath);

  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates]
    .sort(
      (left, right) =>
        scoreCandidate(right, env, nodeExecPath) -
        scoreCandidate(left, env, nodeExecPath),
    )
    .at(0);
}
