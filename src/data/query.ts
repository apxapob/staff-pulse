import { QueryClient, useQuery } from '@tanstack/react-query';
import { DatasetValidationError, parseDataset } from '@/domain/validation';
import { buildOrgIndex } from '@/domain/tree';
import { calculateAggregates } from '@/domain/aggregates';
import type { MetricField } from '@/domain/patch';
import type { OrgAggregate, OrgIndex } from '@/domain/types';

export interface OrgSnapshot {
  index: OrgIndex;
  aggregates: ReadonlyMap<string, OrgAggregate>;
  cursor: string | null;
  changedFields: ReadonlyMap<string, ReadonlySet<MetricField>>;
}

export const ORG_QUERY_KEY = ['org-tree'] as const;
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, gcTime: 300_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export async function fetchOrgTree(
  signal: AbortSignal,
  previous?: OrgSnapshot,
): Promise<OrgSnapshot> {
  const response = await fetch('/api/org-tree', {
    signal,
    headers: previous?.cursor ? { 'If-None-Match': `"${previous.cursor}"` } : {},
  });
  if (response.status === 304 && previous) return previous;
  if (!response.ok) throw new Error(`Сервер вернул ошибку ${response.status}`);
  let nodes;
  try {
    nodes = parseDataset(await response.json());
  } catch (error) {
    if (error instanceof DatasetValidationError)
      throw new Error('API вернул некорректную структуру компании.', { cause: error });
    throw error;
  }
  const cursor = response.headers.get('X-Org-Cursor');
  if (
    previous &&
    nodes.length === previous.index.nodesById.size &&
    nodes.every((node) => {
      const old = previous.index.nodesById.get(node.id);
      return (
        old &&
        Object.keys(node).every(
          (key) => node[key as keyof typeof node] === old[key as keyof typeof old],
        )
      );
    })
  )
    return previous.cursor === cursor ? previous : { ...previous, cursor };
  const index = buildOrgIndex(nodes);
  return { index, aggregates: calculateAggregates(index), cursor, changedFields: new Map() };
}

/** Null means different server instances or a malformed cursor. */
export function compareOrgCursors(first: string | null, second: string | null): number | null {
  const a = first && /^([^:]+):(0|[1-9]\d*)$/.exec(first);
  const b = second && /^([^:]+):(0|[1-9]\d*)$/.exec(second);
  if (
    !a ||
    !b ||
    a[1] !== b[1] ||
    !Number.isSafeInteger(Number(a[2])) ||
    !Number.isSafeInteger(Number(b[2]))
  )
    return null;
  return Number(a[2]) - Number(b[2]);
}

export function reconcileOrgSnapshot(
  received: OrgSnapshot,
  current?: OrgSnapshot,
  atRequestStart?: OrgSnapshot,
): OrgSnapshot {
  if (!current) return received;
  const order = compareOrgCursors(current.cursor, received.cursor);
  if (order !== null && order >= 0) return current;
  // A response from an old process must not replace an already adopted new one.
  if (
    atRequestStart &&
    compareOrgCursors(received.cursor, atRequestStart.cursor) !== null &&
    compareOrgCursors(current.cursor, atRequestStart.cursor) === null &&
    current !== atRequestStart
  )
    return current;
  return received;
}

/** Shared by the initial request, manual refresh, and stream recovery. */
export function orgQueryOptions(client: QueryClient = queryClient) {
  return {
    queryKey: ORG_QUERY_KEY,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const previous = client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY);
      const received = await fetchOrgTree(signal, previous);
      // SSE can advance the cache while this HTTP response is in flight.
      return reconcileOrgSnapshot(
        received,
        client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY),
        previous,
      );
    },
    structuralSharing: false as const,
  };
}

export function useOrgTree() {
  return useQuery(orgQueryOptions());
}
