import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  fetchOrgTree,
  ORG_QUERY_KEY,
  orgQueryOptions,
  reconcileOrgSnapshot,
  type OrgSnapshot,
} from './query';
import { buildOrgIndex } from '@/domain/tree';
import { calculateAggregates } from '@/domain/aggregates';
import { applyLivePatch } from './live';

afterEach(() => vi.unstubAllGlobals());

describe('API boundary and cache lifecycle', () => {
  it('accepts an empty response and rejects invalid data and HTTP failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('[]'))
      .mockResolvedValueOnce(new Response('[{"id":"bad"}]'))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect((await fetchOrgTree(signal)).index.nodesById.size).toBe(0);
    await expect(fetchOrgTree(signal)).rejects.toThrow(
      'API вернул некорректную структуру компании.',
    );
    await expect(fetchOrgTree(signal)).rejects.toThrow('503');
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
  });

  it('deduplicates simultaneous requests and reuses data for five seconds', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, retry: false } },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    const options = {
      queryKey: ORG_QUERY_KEY,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchOrgTree(signal),
    };
    await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
    await client.fetchQuery(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('aborts in-flight fetch when the final observer unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, { signal }: { signal: AbortSignal }) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
        );
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: ORG_QUERY_KEY,
      queryFn: ({ signal }) => fetchOrgTree(signal),
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(requestSignal?.aborted).toBe(false);
    unsubscribe();
    expect(requestSignal?.aborted).toBe(true);
    client.clear();
  });
});

function snapshot(cursor = 'instance:0'): OrgSnapshot {
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
  return { index, aggregates: calculateAggregates(index), cursor, changedFields: new Map() };
}

describe('snapshot and stream concurrency', () => {
  it.each([200, 304])(
    'does not roll back a live patch when a delayed %s snapshot finishes',
    async (status) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const original = snapshot();
      client.setQueryData(ORG_QUERY_KEY, original);
      let respond!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              respond = resolve;
            }),
        ),
      );
      const pending = client.fetchQuery(orgQueryOptions(client));
      const updated = applyLivePatch(original, {
        previousCursor: 'instance:0',
        cursor: 'instance:1',
        changes: [{ id: 'a', headcount: 12, updatedAt: '2026-09-14T01:00:00Z' }],
      });
      client.setQueryData(ORG_QUERY_KEY, updated);
      const current = client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY);
      respond(
        new Response(
          status === 304 ? null : JSON.stringify([...original.index.nodesById.values()]),
          {
            status,
            headers: { 'X-Org-Cursor': 'instance:0' },
          },
        ),
      );
      await pending;
      expect(client.getQueryData(ORG_QUERY_KEY)).toBe(current);
      expect(
        client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY)?.index.nodesById.get('a')?.headcount,
      ).toBe(12);
      client.clear();
    },
  );

  it('adopts a newer snapshot and ignores an old process response after an epoch change', () => {
    const original = snapshot('old:10');
    const newer = snapshot('old:12');
    const restarted = snapshot('new:0');
    expect(reconcileOrgSnapshot(newer, original, original)).toBe(newer);
    expect(reconcileOrgSnapshot(restarted, newer, original)).toBe(restarted);
    expect(reconcileOrgSnapshot(newer, restarted, original)).toBe(restarted);
  });

  it('preserves the entire cached object on an unchanged manual refresh', async () => {
    const client = new QueryClient();
    const original = snapshot();
    client.setQueryData(ORG_QUERY_KEY, original);
    const current = client.getQueryData(ORG_QUERY_KEY);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
    await client.fetchQuery(orgQueryOptions(client));
    expect(client.getQueryData(ORG_QUERY_KEY)).toBe(current);
    client.clear();
  });
});
