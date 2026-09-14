import { QueryClient, useQuery } from '@tanstack/react-query';
import { parseDataset } from '@/domain/validation';

export const ORG_QUERY_KEY = ['org-tree'] as const;
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, gcTime: 300_000, retry: 1, refetchOnWindowFocus: false } },
});

export async function fetchOrgTree(signal: AbortSignal) {
  const response = await fetch('/api/org-tree', { signal });
  if (!response.ok) throw new Error(`Сервер вернул ошибку ${response.status}`);
  return parseDataset(await response.json());
}

export function useOrgTree() {
  return useQuery({ queryKey: ORG_QUERY_KEY, queryFn: ({ signal }) => fetchOrgTree(signal) });
}
