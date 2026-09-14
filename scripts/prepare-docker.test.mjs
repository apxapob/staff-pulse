import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDocker, runDocker } from './prepare-docker.mjs';

const localEndpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const context = (stdout = localEndpoint) => ({ code: 0, stdout });

function harness(replies, overrides = {}) {
  const calls = [];
  const messages = [];
  const delays = [];
  let clock = 0;
  const options = {
    platform: 'win32',
    env: {},
    now: () => clock,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
      clock += milliseconds;
    },
    log: (message) => messages.push(message),
    runDocker: async (args, commandOptions) => {
      calls.push({ args, ...commandOptions });
      const reply = replies.shift();
      assert.notEqual(reply, undefined, `Unexpected command: ${args.join(' ')}`);
      if (reply instanceof Error) throw reply;
      return {
        stdout: args[0] === 'info' && reply === 0 ? 'linux\n' : '',
        stderr: '',
        ...(typeof reply === 'number' ? { code: reply } : reply),
      };
    },
    ...overrides,
  };
  return {
    calls,
    messages,
    delays,
    run: async () => {
      const result = await ensureDocker(options);
      assert.equal(replies.length, 0);
      return result;
    },
  };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: a ready Linux engine completes preflight without other commands`, async () => {
    const { run, calls, messages } = harness([0, 0], { platform });
    assert.equal(await run(), undefined);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['info', '--format', '{{.OSType}}'],
        ['image', 'ls', '--quiet'],
      ],
    );
    assert.ok(calls.every((call) => call.capture && call.timeoutMs === 5000));
    assert.deepEqual(messages, []);
  });
}

test('Windows starts Desktop once and completes only after both APIs respond', async () => {
  const { run, calls, delays, messages } = harness([1, context(), 0, 1, 1, 0, 0]);
  await run();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['info', 'context', 'desktop', 'info', 'info', 'info', 'image'],
  );
  assert.deepEqual(calls[2].args, ['desktop', 'start', '--detach', '--timeout', '30']);
  assert.equal(calls[2].timeoutMs, 30_000);
  assert.deepEqual(delays, [1000, 1000]);
  assert.ok(messages.at(-1).includes('Docker Engine is ready'));
});

for (const endpoint of [
  'unix:///var/run/docker.sock',
  'unix:///Users/alex/.docker/run/docker.sock',
]) {
  test(`macOS starts Desktop for its local socket ${endpoint}`, async () => {
    const { run, calls } = harness([1, context(endpoint), 0, 0, 0], {
      platform: 'darwin',
      userHome: '/Users/alex',
    });
    await run();
    assert.equal(calls[2].args[0], 'desktop');
    assert.equal(calls.at(-1).args[0], 'image');
  });
}

test('an unavailable Linux engine gives an actionable error without service mutations', async () => {
  const { run, calls } = harness([1], { platform: 'linux' });
  await assert.rejects(run(), /Start the configured Docker daemon/);
  assert.equal(calls.length, 1);
});

for (const [name, env, replies] of [
  ['remote DOCKER_HOST', { DOCKER_HOST: 'tcp://server.example:2376' }, [1]],
  ['local custom DOCKER_HOST', { DOCKER_HOST: 'tcp://localhost:2375' }, [1]],
  ['remote selected context', {}, [1, context('ssh://user@server.example')]],
  ['remote named pipe', {}, [1, context('npipe:////server/pipe/docker_engine')]],
]) {
  test(`${name} does not start an irrelevant local Desktop`, async () => {
    const { run, calls } = harness(replies, { env });
    await assert.rejects(run(), /not a local Docker Desktop endpoint/);
    assert.ok(calls.every((call) => call.args[0] !== 'desktop'));
  });
}

test('a custom macOS socket does not start Desktop', async () => {
  const { run, calls } = harness([1, context('unix:///Users/alex/.colima/default/docker.sock')], {
    platform: 'darwin',
    userHome: '/Users/alex',
  });
  await assert.rejects(run(), /not a local Docker Desktop endpoint/);
  assert.equal(calls.length, 2);
});

test('DOCKER_CONTEXT takes precedence over DOCKER_HOST and environment is preserved', async () => {
  const env = {
    DOCKER_CONTEXT: 'desktop-linux',
    DOCKER_HOST: 'tcp://unrelated:2375',
    WEB_PORT: '18080',
  };
  const { run, calls } = harness([1, context(), 0, 0, 0], { env });
  await run();
  assert.deepEqual(calls[1].args, [
    'context',
    'inspect',
    'desktop-linux',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  assert.ok(calls.every((call) => call.env === env));
});

test('an explicit local Docker host does not need a context lookup', async () => {
  const { run, calls } = harness([1, 0, 0, 0], { env: { DOCKER_HOST: localEndpoint } });
  await run();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['info', 'desktop', 'info', 'image'],
  );
});

for (const [name, replies, pattern] of [
  ['invalid context', [1, { code: 1, stdout: '' }], /Cannot inspect the Docker context/],
  ['empty context', [1, context('')], /Cannot inspect the Docker context/],
  ['Desktop failure', [1, context(), 1], /Could not start Docker Desktop/],
  [
    'Desktop timeout',
    [1, context(), { code: 124, timedOut: true }],
    /Could not start Docker Desktop/,
  ],
  ['missing CLI', [new Error('Docker CLI was not found')], /Docker CLI was not found/],
]) {
  test(`${name} fails preflight without reporting readiness`, async () => {
    const { run, messages } = harness(replies);
    await assert.rejects(run(), pattern);
    assert.ok(messages.every((message) => !message.includes('Docker Engine is ready')));
  });
}

test('preflight fails at the readiness deadline', async () => {
  const { run, calls, delays } = harness([1, context(), 0, 1, 1, 1], { timeoutMs: 2500 });
  await assert.rejects(run(), /did not become ready within 2.5 seconds/);
  assert.deepEqual(delays, [1000, 1000, 500]);
  assert.equal(calls.at(-1).timeoutMs, 500);
});

test('an empty successful info response does not mark Docker ready', async () => {
  const { run, calls, delays } = harness([
    1,
    context(),
    0,
    { code: 0, stdout: '' },
    { code: 0, stdout: '  \n' },
    0,
    0,
  ]);
  await run();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['info', 'context', 'desktop', 'info', 'info', 'info', 'image'],
  );
  assert.deepEqual(delays, [1000, 1000]);
});

test('Linux info succeeds before the image API: preflight waits for both APIs', async () => {
  const { run, calls, delays } = harness([1, context(), 0, 0, 1, 0, 0]);
  await run();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['info', 'context', 'desktop', 'info', 'image', 'info', 'image'],
  );
  assert.deepEqual(delays, [1000]);
});

test('the initial readiness probe also rejects an unavailable image API', async () => {
  const { run, calls } = harness([0, 1, context(), 0, 0, 0]);
  await run();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['info', 'image', 'context', 'desktop', 'info', 'image'],
  );
});

test('an image API that never becomes ready fails at the deadline', async () => {
  const { run, calls } = harness([1, context(), 0, 0, 1, 0, 1, 0, 1], { timeoutMs: 2500 });
  await assert.rejects(run(), /did not become ready/);
  assert.equal(calls.at(-1).args[0], 'image');
  assert.equal(calls.at(-1).timeoutMs, 500);
});

test('info and image requests share the same bounded probe time', async () => {
  let clock = 0;
  const calls = [];
  await ensureDocker({
    env: {},
    now: () => clock,
    runDocker: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'info') {
        clock += 4000;
        return { code: 0, stdout: 'linux' };
      }
      return { code: 0, stdout: '' };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.timeoutMs, 5000);
  assert.equal(calls[1].options.timeoutMs, 1000);
});

test('successful replies arriving after the deadline do not complete preflight', async () => {
  let clock = 0;
  let probes = 0;
  await assert.rejects(
    ensureDocker({
      platform: 'win32',
      env: { DOCKER_HOST: localEndpoint },
      timeoutMs: 120_000,
      now: () => clock,
      log: () => {},
      runDocker: async (args) => {
        if (args[0] === 'info') return { code: ++probes === 1 ? 1 : 0, stdout: 'linux' };
        if (args[0] === 'image') clock += 120_000;
        return { code: 0, stdout: '' };
      },
    }),
    /did not become ready/,
  );
});

test('cancellation while waiting fails preflight', async () => {
  const controller = new AbortController();
  const { run, messages } = harness([1, context(), 0, 1], {
    signal: controller.signal,
    delay: async () => controller.abort(new Error('cancelled')),
  });
  await assert.rejects(run(), /cancelled/);
  assert.ok(messages.every((message) => !message.includes('Docker Engine is ready')));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
  };
  return child;
}

test('helper processes use project cwd, literal argv, inherited stdio, and hidden windows', async () => {
  const child = fakeChild();
  const args = ['context', 'inspect', 'name with spaces; $(unsafe)'];
  const promise = runDocker(args, {
    spawnImpl: (executable, actualArgs, options) => {
      assert.equal(executable, 'docker');
      assert.deepEqual(actualArgs, args);
      assert.equal(options.cwd, resolve(fileURLToPath(new URL('..', import.meta.url))));
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  child.emit('close', 23, null);
  assert.equal((await promise).code, 23);
});

test('a hung readiness process is killed when its bounded timeout expires', async () => {
  const child = fakeChild();
  const result = await runDocker(['info'], { capture: true, timeoutMs: 5, spawnImpl: () => child });
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('a missing Docker executable produces an installation hint', async () => {
  const child = fakeChild();
  const promise = runDocker(['info'], { spawnImpl: () => child });
  child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(promise, /Install Docker.*PATH/);
});

test('cancellation terminates a pending preflight process and preserves interrupt status', async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const promise = runDocker(['info'], {
    capture: true,
    signal: controller.signal,
    spawnImpl: () => child,
  });
  controller.abort('SIGINT');
  assert.deepEqual(child.kills, ['SIGINT']);
  assert.equal((await promise).code, 130);
});
