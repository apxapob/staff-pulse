import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSearchStatus, type SearchStatus } from '../src/search/status.js';
import { createAppServer } from './app.js';
import { resolveSearchStatus } from './search-status.js';

const model = 'search-test:small';
const env = {
  SEARCH_PROVIDER: 'ollama',
  OLLAMA_MODEL: model,
  MODEL_STATUS_URL: 'http://model-init:3002',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe('public search status contract', () => {
  it.each(['ready', 'preparing', 'downloading', 'warming', 'error', 'unavailable'])(
    'accepts the public %s state',
    (status) => expect(parseSearchStatus({ status })).toEqual({ status }),
  );

  it.each([null, [], {}, { status: 'other' }, { status: 'ready', model }, { status: 1 }])(
    'rejects malformed or private fields: %j',
    (value) => expect(() => parseSearchStatus(value)).toThrow(),
  );
});

describe('search status resolver', () => {
  it.each([
    {},
    { SEARCH_PROVIDER: 'local', AI_API_KEY: 'private-key' },
    { SEARCH_PROVIDER: 'openai', AI_API_KEY: 'private-key' },
    { AI_API_KEY: 'private-key' },
  ])('reports non-Ollama providers ready without any network access: %j', async (providerEnv) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await resolveSearchStatus({ env: providerEnv, fetch })).toEqual({ status: 'ready' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'downloading', 'warming', 'ready', 'error'])(
    'publishes only the matching manager %s state',
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ model, status }));
      expect(
        await resolveSearchStatus({ env: { ...env, AI_API_KEY: 'never-send' }, fetch }),
      ).toEqual({ status });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, request] = fetch.mock.calls[0];
      expect(url).toBe('http://model-init:3002/status');
      expect(request?.method).toBe('GET');
      expect(request?.headers).toBeUndefined();
      expect(request?.body).toBeUndefined();
      expect(request?.signal?.aborted).toBe(true);
    },
  );

  it.each([
    null,
    [],
    {},
    { status: 'ready' },
    { model: 'previous-model:old', status: 'ready' },
    { model, status: 'unknown' },
    { model, status: 'unavailable' },
    { model, status: 'ready', error: 'private path and credential' },
  ])('never accepts stale or malformed manager readiness: %j', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
    expect(await resolveSearchStatus({ env, fetch })).toEqual({ status: 'unavailable' });
  });

  it('sanitizes network errors without falling back to a cloud provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('private-key'));
    expect(
      await resolveSearchStatus({ env: { ...env, AI_API_KEY: 'private-key' }, fetch }),
    ).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://model-init:3002/status');
  });

  it('releases an unfinished HTTP error body immediately', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(stream, { status: 503 }));
    expect(await resolveSearchStatus({ env, fetch })).toEqual({ status: 'unavailable' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('limits an unresponsive transport to one second independently of the AI timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise(() => {}));
    const result = resolveSearchStatus({ env: { ...env, AI_TIMEOUT_MS: '120000' }, fetch });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ status: 'unavailable' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('aborts a real response whose JSON body never finishes', async () => {
    let bodyClosed = false;
    const manager = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"model":');
        response.once('close', () => {
          bodyClosed = true;
        });
      }),
    );
    expect(
      await resolveSearchStatus({ env: { ...env, MODEL_STATUS_URL: manager }, timeoutMs: 100 }),
    ).toEqual({ status: 'unavailable' });
    await vi.waitFor(() => expect(bodyClosed).toBe(true));
  });

  it('propagates caller cancellation and does not expose it as model readiness', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise(() => {}));
    const result = resolveSearchStatus({ env, fetch, signal: controller.signal });
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each([
    { ...env, MODEL_STATUS_URL: 'http://user:secret@model-init:3002' },
    { ...env, MODEL_STATUS_URL: 'file:///private/status' },
    { ...env, MODEL_STATUS_URL: 'http://model-init:3002/status' },
    { ...env, OLLAMA_MODEL: 'invalid model' },
    { ...env, SEARCH_PROVIDER: 'unknown' },
  ])('rejects invalid server configuration without making requests: %j', async (invalidEnv) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await resolveSearchStatus({ env: invalidEnv, fetch })).toEqual({
      status: 'unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks only the configured Ollama model in direct development', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ modelfile: 'FROM cached-weights' }));
    expect(await resolveSearchStatus({ env: { SEARCH_PROVIDER: 'ollama' }, fetch })).toEqual({
      status: 'ready',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/show');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(request?.body as string)).toEqual({
      model: 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0',
    });
    expect(request?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it.each([
    [404, { error: 'model not found' }, 'error'],
    [500, { error: 'private details' }, 'unavailable'],
    [200, {}, 'unavailable'],
  ] as const)(
    'direct development handles HTTP %s without downloading',
    async (code, body, status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body, code));
      expect(await resolveSearchStatus({ env: { SEARCH_PROVIDER: 'ollama' }, fetch })).toEqual({
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe('search status HTTP route', () => {
  it('returns only the public state without caching, while health remains independent', async () => {
    const searchStatus = vi
      .fn<typeof resolveSearchStatus>()
      .mockResolvedValue({ status: 'downloading' });
    const origin = await listen(createAppServer({ liveIntervalMs: 0, searchStatus }));
    const response = await fetch(`${origin}/api/search/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'downloading' });
    expect(await (await fetch(`${origin}/api/health`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${origin}/api/org-tree`)).status).toBe(200);
    expect(searchStatus).toHaveBeenCalledOnce();
  });

  it('allows only GET and never invokes the resolver for other methods', async () => {
    const searchStatus = vi.fn<typeof resolveSearchStatus>();
    const origin = await listen(createAppServer({ liveIntervalMs: 0, searchStatus }));
    const response = await fetch(`${origin}/api/search/status`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(searchStatus).not.toHaveBeenCalled();
  });

  it.each([
    () => Promise.reject(new Error('private model path and credential')),
    () => Promise.resolve({ status: 'ready', model: 'private-model' } as SearchStatus),
  ])('sanitizes failed or malformed injected resolvers', async (searchStatus) => {
    const origin = await listen(createAppServer({ liveIntervalMs: 0, searchStatus }));
    expect(await (await fetch(`${origin}/api/search/status`)).json()).toEqual({
      status: 'unavailable',
    });
  });

  it('cancels status work when its client disconnects', async () => {
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal!: AbortSignal;
    const searchStatus: typeof resolveSearchStatus = (options) =>
      new Promise((_resolve, reject) => {
        signal = options!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      });
    const origin = await listen(createAppServer({ liveIntervalMs: 0, searchStatus }));
    const request = httpRequest(`${origin}/api/search/status`);
    request.on('error', () => {});
    request.end();
    await resolverStarted;
    expect(signal.aborted).toBe(false);
    request.destroy();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  });
});
