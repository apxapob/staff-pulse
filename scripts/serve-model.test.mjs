import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createModelServer } from './serve-model.mjs';

const model = 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function listen(t, options) {
  const server = createModelServer({ model, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = async () => {
    const response = await fetch(`${url}/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^application\/json/);
    return response.json();
  };
  return { server, url, status };
}

test('HTTP status is available while preparation is blocked, then tracks download and warmup', async (t) => {
  const preparation = deferred();
  let onStatus;
  let calls = 0;
  const { server, status } = await listen(t, {
    prepare: (options) => {
      calls++;
      assert.equal(options.model, model);
      assert.ok(options.signal instanceof AbortSignal);
      onStatus = options.onStatus;
      return preparation.promise;
    },
  });
  assert.equal(server.listening, true);
  assert.equal(calls, 1);
  assert.deepEqual(await status(), { model, status: 'preparing' });
  onStatus('downloading');
  assert.deepEqual(await status(), { model, status: 'downloading' });
  onStatus('warming');
  assert.deepEqual(await status(), { model, status: 'warming' });
  // A callback cannot bypass the completion gate or publish arbitrary states.
  onStatus('ready');
  onStatus('unexpected');
  assert.deepEqual(await status(), { model, status: 'warming' });
  preparation.resolve();
  assert.deepEqual(await status(), { model, status: 'ready' });
  onStatus('downloading');
  assert.deepEqual(await status(), { model, status: 'ready' });
});

test('a cached model can move directly from preparing to warming and ready', async (t) => {
  const warmup = deferred();
  const { status } = await listen(t, {
    prepare: ({ onStatus }) => {
      onStatus('warming');
      return warmup.promise;
    },
  });
  assert.deepEqual(await status(), { model, status: 'warming' });
  warmup.resolve();
  assert.deepEqual(await status(), { model, status: 'ready' });
});

for (const synchronous of [false, true]) {
  test(`preparation error keeps status HTTP alive without exposing details (sync=${synchronous})`, async (t) => {
    const errors = [];
    const secret = 'internal download failed at /private/cache/secret';
    const { status } = await listen(t, {
      prepare: () => {
        if (synchronous) throw new Error(secret);
        return Promise.reject(new Error(secret));
      },
      logError: (message) => errors.push(message),
    });
    assert.deepEqual(await status(), { model, status: 'error' });
    assert.deepEqual(await status(), { model, status: 'error' });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(secret));
  });
}

test('closing the HTTP server aborts preparation and suppresses shutdown errors', async (t) => {
  let preparationSignal;
  const errors = [];
  const { server } = await listen(t, {
    prepare: ({ signal }) => {
      preparationSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    logError: (message) => errors.push(message),
  });
  server.close();
  await once(server, 'close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparationSignal.aborted, true);
  assert.deepEqual(errors, []);
});

test('a fresh server reruns preparation and resets an earlier terminal state', async (t) => {
  let calls = 0;
  const first = await listen(t, {
    prepare: async () => {
      calls++;
    },
  });
  assert.deepEqual(await first.status(), { model, status: 'ready' });
  first.server.close();
  await once(first.server, 'close');
  const pending = deferred();
  const second = await listen(t, {
    prepare: () => {
      calls++;
      return pending.promise;
    },
  });
  assert.deepEqual(await second.status(), { model, status: 'preparing' });
  assert.equal(calls, 2);
  pending.resolve();
  assert.deepEqual(await second.status(), { model, status: 'ready' });
});

test('unknown routes and unsupported methods do not invoke preparation again', async (t) => {
  let calls = 0;
  const { url } = await listen(t, {
    prepare: async () => {
      calls++;
    },
  });
  const missing = await fetch(`${url}/unknown`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
  const wrongMethod = await fetch(`${url}/status`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.equal(wrongMethod.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await wrongMethod.json(), { error: 'Method not allowed' });
  assert.equal(calls, 1);
});
