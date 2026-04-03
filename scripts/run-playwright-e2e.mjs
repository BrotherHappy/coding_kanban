import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = '127.0.0.1';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a free port')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function spawnProcess(command, args, env) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    detached: true,
  });
}

async function waitForUrl(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }

      lastError = new Error(`${label} responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw new Error(`${label} did not become ready: ${String(lastError)}`);
}

function terminateProcess(child) {
  if (!child?.pid) {
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

async function main() {
  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://${host}:${backendPort}`;
  const frontendUrl = `http://${host}:${frontendPort}`;
  const testPath = [
    `${process.cwd()}/.playwright-bin`,
    process.env.PATH ?? '',
  ].join(':');

  const sharedEnv = {
    ...process.env,
    PATH: testPath,
    PLAYWRIGHT_SKIP_WEBSERVER: '1',
    PLAYWRIGHT_BACKEND_HOST: host,
    PLAYWRIGHT_BACKEND_PORT: String(backendPort),
    PLAYWRIGHT_BACKEND_URL: backendUrl,
    PLAYWRIGHT_FRONTEND_HOST: host,
    PLAYWRIGHT_FRONTEND_PORT: String(frontendPort),
    PLAYWRIGHT_BASE_URL: frontendUrl,
    PLAYWRIGHT_USE_MOCK_COPILOT: '1',
  };

  const sharedBuild = spawn('pnpm', ['--filter', 'shared', 'build'], {
    cwd: process.cwd(),
    env: sharedEnv,
    stdio: 'inherit',
  });

  const sharedBuildExitCode = await new Promise((resolve, reject) => {
    sharedBuild.on('error', reject);
    sharedBuild.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });

  if (sharedBuildExitCode !== 0) {
    process.exit(sharedBuildExitCode);
  }

  const backendProcess = spawnProcess(
    'pnpm',
    ['--filter', 'server', 'exec', 'tsx', 'watch', 'src/index.ts'],
    {
      ...sharedEnv,
      HOST: host,
      PORT: String(backendPort),
    },
  );

  const frontendProcess = spawnProcess(
    'pnpm',
    [
      '--filter',
      'web',
      'exec',
      'vite',
      '--host',
      host,
      '--port',
      String(frontendPort),
    ],
    {
      ...sharedEnv,
      VITE_BACKEND_URL: backendUrl,
    },
  );

  const cleanup = () => {
    terminateProcess(frontendProcess);
    terminateProcess(backendProcess);
  };

  const handleSignal = (code) => {
    cleanup();
    process.exit(code);
  };

  process.on('SIGINT', () => handleSignal(130));
  process.on('SIGTERM', () => handleSignal(143));

  try {
    await waitForUrl(`${backendUrl}/api/health`, 'backend');
    await waitForUrl(frontendUrl, 'frontend');

    const rawArgs = process.argv.slice(2);
    const playwrightArgs =
      rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
    const testProcess = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', ...playwrightArgs],
      {
        cwd: process.cwd(),
        env: sharedEnv,
        stdio: 'inherit',
      },
    );

    const exitCode = await new Promise((resolve, reject) => {
      testProcess.on('error', reject);
      testProcess.on('exit', (code, signal) => {
        if (signal) {
          resolve(1);
          return;
        }

        resolve(code ?? 1);
      });
    });

    cleanup();
    await delay(500);
    process.exit(exitCode);
  } catch (error) {
    cleanup();
    console.error(error);
    process.exit(1);
  }
}

await main();
