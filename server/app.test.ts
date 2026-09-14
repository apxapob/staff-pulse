import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppServer, readLiveInterval, readServerPort, type AppServerOptions } from './app.js';
import { getFreshOrgTree } from './data.js';
import { OrgStore } from './org-store.js';

const runningServers: Server[] = [];

async function startServer(options: AppServerOptions = {}): Promise<string> {
  const server = createAppServer({ liveIntervalMs: 0, ...options });
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an assigned TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function openEvents(url: string, headers?: HeadersInit) {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal, headers });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    response,
    close: () => abort.abort(),
    async next(): Promise<{ event: string; data: unknown; id?: string }> {
      while (true) {
        const separator = pending.indexOf('\n\n');
        if (separator !== -1) {
          const block = pending.slice(0, separator);
          pending = pending.slice(separator + 2);
          if (block.startsWith(':')) continue;
          const fields = Object.fromEntries(
            block.split('\n').map((line) => {
              const colon = line.indexOf(':');
              return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
            }),
          );
          return {
            event: fields.event!,
            data: JSON.parse(fields.data!),
            ...(fields.id ? { id: fields.id } : {}),
          };
        }
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE connection ended before the next event');
        pending += decoder.decode(value, { stream: true });
      }
    },
  };
}

describe('organisation API', () => {
  it('returns the flat organisation tree as uncached JSON', async () => {
    const origin = await startServer();
    const response = await fetch(`${origin}/api/org-tree`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(getFreshOrgTree());
  });

  it('rejects writes and unknown routes', async () => {
    const origin = await startServer();
    const response = await fetch(`${origin}/api/org-tree`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect((await fetch(`${origin}/api/missing`)).status).toBe(404);
  });

  it('returns a cursor and revalidates a snapshot without transferring unchanged data', async () => {
    const store = new OrgStore({ instanceId: 'test' });
    const origin = await startServer({ store });
    const first = await fetch(`${origin}/api/org-tree`);
    expect(first.headers.get('X-Org-Cursor')).toBe('test:0');
    expect(first.headers.get('ETag')).toBe('"test:0"');
    await first.json();
    const unchanged = await fetch(`${origin}/api/org-tree`, {
      headers: { 'If-None-Match': '"test:0"' },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('X-Org-Cursor')).toBe('test:0');
    store.commit([{ id: 'technology', headcount: 5 }]);
    const changed = await fetch(`${origin}/api/org-tree`, {
      headers: { 'If-None-Match': '"test:0"' },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('X-Org-Cursor')).toBe('test:1');
    expect((await changed.json())[0].headcount).toBe(5);
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  });
});

describe('organisation event stream', () => {
  it('replays changes after the snapshot, then sends live patches without a gap', async () => {
    const store = new OrgStore({ instanceId: 'test' });
    const origin = await startServer({ store });
    const snapshot = await fetch(`${origin}/api/org-tree`);
    const cursor = snapshot.headers.get('X-Org-Cursor');
    await snapshot.json();
    const replayed = store.commit([{ id: 'technology', headcount: 5 }]);
    const stream = await openEvents(`${origin}/api/org-events?cursor=${cursor}`);
    expect(stream.response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(await stream.next()).toEqual({ event: 'patch', data: replayed, id: 'test:1' });
    expect(await stream.next()).toEqual({
      event: 'ready',
      data: { cursor: 'test:1' },
      id: 'test:1',
    });
    const live = store.commit([{ id: 'frontend', performance: 94 }]);
    expect(await stream.next()).toEqual({ event: 'patch', data: live, id: 'test:2' });
    expect(store.subscriberCount).toBe(1);
    stream.close();
    await vi.waitFor(() => expect(store.subscriberCount).toBe(0));
  });

  it('resumes from Last-Event-ID instead of replaying the original URL cursor', async () => {
    const store = new OrgStore({ instanceId: 'test' });
    const origin = await startServer({ store });
    store.commit([{ id: 'technology', headcount: 5 }]);
    const second = store.commit([{ id: 'frontend', performance: 94 }]);
    const stream = await openEvents(`${origin}/api/org-events?cursor=test:0`, {
      'Last-Event-ID': 'test:1',
    });
    expect(await stream.next()).toEqual({ event: 'patch', data: second, id: 'test:2' });
    expect(await stream.next()).toEqual({
      event: 'ready',
      data: { cursor: 'test:2' },
      id: 'test:2',
    });
    stream.close();
  });

  it('requests a fresh snapshot for an expired cursor or changed server instance', async () => {
    const store = new OrgStore({ instanceId: 'test', historySize: 1 });
    const origin = await startServer({ store });
    store.commit([{ id: 'technology', headcount: 5 }]);
    store.commit([{ id: 'frontend', performance: 94 }]);
    for (const [cursor, reason] of [
      ['test:0', 'history-gap'],
      ['old:1', 'instance-changed'],
    ]) {
      const response = await fetch(`${origin}/api/org-events?cursor=${cursor}`);
      expect(await response.text()).toBe(`event: resync\ndata: {"reason":"${reason}"}\n\n`);
    }
    expect(store.subscriberCount).toBe(0);
  });

  it('closes subscribers and automatic updates when the server shuts down', async () => {
    const store = new OrgStore({ instanceId: 'test' });
    const origin = await startServer({ store, liveIntervalMs: 10 });
    const stream = await openEvents(`${origin}/api/org-events?cursor=test:0`);
    await stream.next();
    await vi.waitFor(() => expect(store.cursor).not.toBe('test:0'));
    const server = runningServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(store.subscriberCount).toBe(0);
    const cursor = store.cursor;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.cursor).toBe(cursor);
    stream.close();
  });
});

describe('PORT configuration', () => {
  it('defaults to 3001 and accepts a valid override', () => {
    expect(readServerPort({})).toBe(3001);
    expect(readServerPort({ PORT: '4321' })).toBe(4321);
  });

  it.each(['', '0', '-1', '1.5', '65536', '3001garbage', 'Infinity'])(
    'rejects invalid PORT %s',
    (port) => expect(() => readServerPort({ PORT: port })).toThrow('PORT must be an integer'),
  );
});

describe('live interval configuration', () => {
  it('defaults to eight seconds and accepts a valid override', () => {
    expect(readLiveInterval({})).toBe(8_000);
    expect(readLiveInterval({ LIVE_INTERVAL_MS: '1000' })).toBe(1_000);
  });

  it.each(['', '0', '-1', '999', '1000.5', '3600001', '8000x'])(
    'rejects invalid LIVE_INTERVAL_MS %s',
    (interval) =>
      expect(() => readLiveInterval({ LIVE_INTERVAL_MS: interval })).toThrow(
        'LIVE_INTERVAL_MS must be an integer',
      ),
  );
});
