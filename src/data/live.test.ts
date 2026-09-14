import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { buildOrgIndex } from '@/domain/tree';
import { calculateAggregates } from '@/domain/aggregates';
import {
  applyLivePatch,
  createLiveConnection,
  reconnectDelay,
  type ConnectionStatus,
} from './live';
import { ORG_QUERY_KEY, orgQueryOptions, type OrgSnapshot } from './query';

const index = buildOrgIndex([
  {
    id: 'a',
    name: 'A',
    parentId: null,
    headcount: 10,
    budget: 200,
    performance: 80,
    updatedAt: '2026-09-14T00:00:00Z',
  },
]);
const snapshot: OrgSnapshot = {
  index,
  aggregates: calculateAggregates(index),
  cursor: 'instance:0',
  changedFields: new Map(),
};
describe('ordered live cache updates', () => {
  it('applies metric deltas without another API snapshot', () => {
    const next = applyLivePatch(snapshot, {
      previousCursor: 'instance:0',
      cursor: 'instance:1',
      changes: [{ id: 'a', headcount: 12, updatedAt: '2026-09-14T01:00:00Z' }],
    });
    expect(next.aggregates.get('a')?.headcount).toBe(12);
    expect(next.cursor).toBe('instance:1');
    expect(snapshot.aggregates.get('a')?.headcount).toBe(10);
  });
  it('ignores duplicate cursors and rejects a gap or malformed data', () => {
    expect(
      applyLivePatch(snapshot, { previousCursor: 'old', cursor: 'instance:0', changes: [] }),
    ).toBe(snapshot);
    expect(() =>
      applyLivePatch(snapshot, { previousCursor: 'instance:3', cursor: 'instance:4', changes: [] }),
    ).toThrow('последовательность');
    expect(() => applyLivePatch(snapshot, { cursor: 2 })).toThrow();
  });
  it('backs off exponentially with a 30 second ceiling and bounded jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((n) => reconnectDelay(n, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(reconnectDelay(0, () => 0)).toBe(800);
  });
  it('ignores stream patches already included by a newer HTTP snapshot', () => {
    const current = { ...snapshot, cursor: 'instance:3' };
    expect(
      applyLivePatch(current, { previousCursor: 'instance:0', cursor: 'instance:1', changes: [] }),
    ).toBe(current);
    expect(() =>
      applyLivePatch(current, { previousCursor: 'instance:3', cursor: 'instance:5', changes: [] }),
    ).toThrow('последовательность');
  });
});

class FakeSource extends EventTarget {
  close = vi.fn();
  constructor(readonly url: string) {
    super();
  }
  emit(event: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

describe('live connection lifecycle', () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(ORG_QUERY_KEY, snapshot);
    const sources: FakeSource[] = [];
    const statuses: ConnectionStatus[] = [];
    let online = true;
    const connection = createLiveConnection({
      client,
      random: () => 1,
      isOnline: () => online,
      onStatus: (status) => {
        statuses.push(status);
      },
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
    });
    cleanups.push(() => {
      connection.stop();
      client.clear();
    });
    connection.start();
    return {
      client,
      sources,
      statuses,
      connection,
      setOnline: (value: boolean) => {
        online = value;
      },
    };
  }

  it('fetches once on resync and explicitly reconnects without remounting', async () => {
    const { sources, statuses } = setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([...index.nodesById.values()]), {
          headers: { 'X-Org-Cursor': 'restarted:0' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    sources[0]!.emit('ready', { cursor: 'instance:0' });
    sources[0]!.emit('resync', { reason: 'instance-changed' });
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
    expect(sources[1]!.url).toContain('restarted%3A0');
    sources[1]!.emit('ready', { cursor: 'restarted:0' });
    expect(statuses.at(-1)).toBe('live');
  });

  it('keeps snapshot recovery pending after HTTP failure and retries with backoff', async () => {
    const { sources, statuses, client } = setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network error'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);
    sources[0]!.emit('resync');
    await vi.advanceTimersByTimeAsync(0);
    expect(sources).toHaveLength(1);
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY)?.cursor).toBe('instance:0');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(2);
  });

  it('backs off across short connections, then resets after ten stable seconds', async () => {
    const { sources } = setup();
    sources[0]!.emit('ready', { cursor: 'instance:0' });
    sources[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    sources[1]!.emit('ready', { cursor: 'instance:0' });
    sources[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    sources[2]!.emit('ready', { cursor: 'instance:0' });
    await vi.advanceTimersByTimeAsync(10_000);
    sources[2]!.emit('error');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(4);
  });

  it('does not open a source when a pending recovery resolves after disposal', async () => {
    const { connection, sources, statuses } = setup();
    let respond!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      }),
    );
    sources[0]!.emit('resync');
    connection.stop();
    expect(signal.aborted).toBe(true);
    const lastStatusCount = statuses.length;
    respond(new Response(null, { status: 304 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sources).toHaveLength(1);
    expect(statuses).toHaveLength(lastStatusCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores old listeners, pauses offline, and resumes from the current cache', async () => {
    const { connection, sources, client, statuses, setOnline } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sources[0]!.emit('ready', { cursor: 'instance:0' });
    sources[0]!.emit('patch', {
      previousCursor: 'instance:0',
      cursor: 'instance:1',
      changes: [{ id: 'a', budget: 250, updatedAt: '2026-09-14T01:00:00Z' }],
    });
    expect(client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY)?.aggregates.get('a')?.budget).toBe(250);
    expect(fetchMock).not.toHaveBeenCalled();
    setOnline(false);
    connection.offline();
    sources[0]!.emit('resync');
    sources[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses.at(-1)).toBe('offline');
    expect(sources).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    setOnline(true);
    connection.online();
    expect(sources).toHaveLength(2);
    expect(sources[1]!.url).toContain('instance%3A1');
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows only the newest generation to reconnect after an overlapping recovery', async () => {
    const { connection, sources, setOnline } = setup();
    const signals: AbortSignal[] = [];
    const responses: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn((_url, options) => {
      signals.push(options.signal);
      return new Promise<Response>((resolve) => {
        responses.push(resolve);
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    sources[0]!.emit('resync');
    setOnline(false);
    connection.offline();
    expect(signals[0]!.aborted).toBe(true);
    setOnline(true);
    connection.online();
    responses[0]!(new Response(null, { status: 304 }));
    responses[1]!(new Response(null, { status: 304 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(2);
  });

  it('backs off repeated resyncs until the recovered stream has stayed stable', async () => {
    const { sources } = setup();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
    vi.stubGlobal('fetch', fetchMock);
    sources[0]!.emit('resync');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sources[1]!.emit('ready', { cursor: 'instance:0' });
    sources[1]!.emit('resync');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    sources[2]!.emit('ready', { cursor: 'instance:0' });
    await vi.advanceTimersByTimeAsync(10_000);
    sources[2]!.emit('resync');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not abort a manual refresh that recovery joined', async () => {
    const { sources, connection, client } = setup();
    let signal!: AbortSignal;
    let respond!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      }),
    );
    const manualRefresh = client.fetchQuery(orgQueryOptions(client));
    sources[0]!.emit('resync');
    connection.stop();
    expect(signal.aborted).toBe(false);
    respond(new Response(null, { status: 304 }));
    await manualRefresh;
    expect(sources).toHaveLength(1);
  });
});
