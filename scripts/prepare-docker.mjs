import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function runDocker(
  args,
  { capture = false, timeoutMs, signal, env = process.env, spawnImpl = spawn } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawnImpl('docker', args, {
      cwd: projectRoot,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const abort = () => child.kill(signal.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    // Readiness probes have tiny output; cap captured diagnostics even on a broken CLI.
    child.stdout?.on('data', (chunk) => (stdout = (stdout + chunk).slice(-8192)));
    child.stderr?.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      cleanup();
      reject(
        error.code === 'ENOENT'
          ? new Error('Docker CLI was not found. Install Docker and make sure docker is on PATH.')
          : error,
      );
    });
    child.once('close', (code, exitSignal) => {
      cleanup();
      resolveResult({
        code: timedOut
          ? 124
          : signal?.aborted
            ? signal.reason === 'SIGTERM'
              ? 143
              : 130
            : (code ?? (exitSignal === 'SIGINT' ? 130 : 1)),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function isDesktopEndpoint(endpoint, platform, userHome) {
  if (platform === 'win32') {
    return /^npipe:\/\/\/\/\.\/pipe\/(dockerDesktopLinuxEngine|docker_engine)$/i.test(endpoint);
  }
  return (
    platform === 'darwin' &&
    (endpoint === 'unix:///var/run/docker.sock' ||
      endpoint === `unix://${userHome}/.docker/run/docker.sock`)
  );
}

export async function ensureDocker({
  platform = process.platform,
  env = process.env,
  userHome = homedir(),
  runDocker: run = runDocker,
  now = Date.now,
  delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }),
  log = console.info,
  signal,
  timeoutMs = 120_000,
} = {}) {
  const command = async (commandArgs, options = {}) => {
    signal?.throwIfAborted();
    const result = await run(commandArgs, { env, signal, ...options });
    signal?.throwIfAborted();
    return result;
  };
  const probe = async (limit = 5000) => {
    const probeDeadline = now() + limit;
    const info = await command(['info', '--format', '{{.OSType}}'], {
      capture: true,
      timeoutMs: limit,
    });
    if (info.code !== 0 || info.stdout.trim() !== 'linux') return false;
    const imageTimeout = probeDeadline - now();
    if (imageTimeout <= 0) return false;
    // During Desktop startup, info can respond before the image API used by Compose.
    const images = await command(['image', 'ls', '--quiet'], {
      capture: true,
      timeoutMs: imageTimeout,
    });
    return images.code === 0;
  };

  if (!(await probe())) {
    if (!['win32', 'darwin'].includes(platform)) {
      throw new Error(
        'Docker Engine is unavailable. Start the configured Docker daemon and check docker info, then retry.',
      );
    }
    const deadline = now() + timeoutMs;
    const remaining = () => {
      const milliseconds = deadline - now();
      if (milliseconds <= 0) {
        throw new Error(
          `Docker Engine did not become ready within ${timeoutMs / 1000} seconds. Open Docker Desktop and check its startup status, then retry.`,
        );
      }
      return milliseconds;
    };
    // DOCKER_CONTEXT takes precedence over DOCKER_HOST, just as in the Docker CLI.
    let endpoint = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
    if (!endpoint) {
      const context = await command(
        [
          'context',
          'inspect',
          ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
          '--format',
          '{{.Endpoints.docker.Host}}',
        ],
        { capture: true, timeoutMs: Math.min(5000, remaining()) },
      );
      if (context.code !== 0 || !context.stdout.trim()) {
        throw new Error('Cannot inspect the Docker context. Check docker context show and retry.');
      }
      endpoint = context.stdout.trim();
    }
    if (!isDesktopEndpoint(endpoint, platform, userHome)) {
      throw new Error(
        'The configured Docker endpoint is unavailable and is not a local Docker Desktop endpoint. Check DOCKER_HOST and docker context show, or start that engine, then retry.',
      );
    }
    log('Docker Engine is not running. Starting Docker Desktop...');
    const launchTimeout = Math.min(30_000, remaining());
    const launched = await command(
      ['desktop', 'start', '--detach', '--timeout', String(Math.ceil(launchTimeout / 1000))],
      { timeoutMs: launchTimeout },
    );
    if (launched.code !== 0) {
      throw new Error(
        'Could not start Docker Desktop. Open it manually and check its status, then retry.',
      );
    }
    log('Waiting for Docker Engine to become ready...');
    while (true) {
      const ready = await probe(Math.min(5000, remaining()));
      remaining();
      if (ready) break;
      await delay(Math.min(1000, remaining()), signal);
    }
    log('Docker Engine is ready. Starting the application...');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await ensureDocker({ signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      process.exitCode = controller.signal.reason === 'SIGTERM' ? 143 : 130;
    } else {
      console.error(`Startup failed: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
