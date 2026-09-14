import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { applyMetricChanges } from '@/domain/patch';
import {
  compareOrgCursors,
  ORG_QUERY_KEY,
  orgQueryOptions,
  queryClient,
  type OrgSnapshot,
} from '@/data/query';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Capped exponential delay, with jitter to avoid synchronized reconnects. */
export function reconnectDelay(attempt: number, random = Math.random): number {
  return Math.round(Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) * (0.8 + random() * 0.2));
}

export function applyLivePatch(snapshot: OrgSnapshot, input: unknown): OrgSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Некорректный live-патч');
  const patch = input as Record<string, unknown>;
  if (
    typeof patch.cursor !== 'string' ||
    typeof patch.previousCursor !== 'string' ||
    !Array.isArray(patch.changes)
  )
    throw new Error('Некорректный live-патч');
  const order = compareOrgCursors(patch.cursor, snapshot.cursor);
  // A concurrent HTTP refresh can already include patches queued in the stream.
  if (order !== null && order <= 0) return snapshot;
  if (
    patch.previousCursor !== snapshot.cursor ||
    compareOrgCursors(patch.cursor, patch.previousCursor) !== 1
  ) {
    throw new Error('Нарушена последовательность обновлений');
  }
  const result = applyMetricChanges(snapshot.index, snapshot.aggregates, patch.changes);
  return {
    index: result.index,
    aggregates: result.aggregates,
    cursor: patch.cursor,
    changedFields: result.changedFields,
  };
}

interface Stream {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export interface LiveConnectionOptions {
  onStatus: (status: ConnectionStatus) => void;
  client?: QueryClient;
  createSource?: (url: string) => Stream;
  isOnline?: () => boolean;
  random?: () => number;
}

/** The connection owns recovery; it does not depend on React rendering fetch states. */
export function createLiveConnection({
  onStatus,
  client = queryClient,
  createSource = (url) => new EventSource(url),
  isOnline = () => navigator.onLine,
  random = Math.random,
}: LiveConnectionOptions) {
  let disposed = false;
  let started = false;
  let source: Stream | undefined;
  let removeListeners: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let needsSnapshot = false;
  let hasConnected = false;
  let recoveryAttempted = false;
  let ownedRecoveryGeneration: number | undefined;

  const clearRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const disconnect = () => {
    generation += 1;
    removeListeners?.();
    removeListeners = undefined;
    source?.close();
    source = undefined;
    clearTimeout(stableTimer);
    stableTimer = undefined;
  };
  const active = (expectedGeneration: number) =>
    !disposed && started && expectedGeneration === generation;
  const cancelOwnedRecovery = () => {
    if (ownedRecoveryGeneration === undefined) return;
    ownedRecoveryGeneration = undefined;
    // Only cancel a request started by this controller, never a shared manual refresh.
    void client.cancelQueries({ queryKey: ORG_QUERY_KEY, exact: true });
  };

  const retry = () => {
    disconnect();
    if (disposed || !started || retryTimer !== undefined) return;
    onStatus(isOnline() ? 'reconnecting' : 'offline');
    if (!isOnline()) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void connect();
      },
      reconnectDelay(attempt++, random),
    );
  };

  const resync = () => {
    needsSnapshot = true;
    clearRetry();
    if (recoveryAttempted) retry();
    else {
      recoveryAttempted = true;
      void connect();
    }
  };

  const connect = async () => {
    disconnect();
    if (disposed || !started) return;
    const connectionGeneration = generation;
    if (!isOnline()) {
      onStatus('offline');
      return;
    }
    onStatus(hasConnected || needsSnapshot ? 'reconnecting' : 'connecting');

    if (needsSnapshot) {
      const fetchStatus = client.getQueryState(ORG_QUERY_KEY)?.fetchStatus;
      if (fetchStatus !== 'fetching' && fetchStatus !== 'paused')
        ownedRecoveryGeneration = connectionGeneration;
      try {
        // Recovery only. Normal patches update the cache directly without refetch.
        await client.fetchQuery({ ...orgQueryOptions(client), staleTime: 0, retry: false });
      } catch {
        if (active(connectionGeneration)) retry();
        return;
      } finally {
        if (ownedRecoveryGeneration === connectionGeneration) ownedRecoveryGeneration = undefined;
      }
      if (!active(connectionGeneration)) return;
      needsSnapshot = false;
    }

    const current = client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY);
    if (!current?.cursor) {
      needsSnapshot = true;
      retry();
      return;
    }
    let nextSource: Stream;
    try {
      nextSource = createSource(`/api/org-events?cursor=${encodeURIComponent(current.cursor)}`);
    } catch {
      retry();
      return;
    }
    source = nextSource;
    const currentConnection = () => active(connectionGeneration) && source === nextSource;
    const ready = (event: Event) => {
      if (!currentConnection()) return;
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        const latest = client.getQueryData<OrgSnapshot>(ORG_QUERY_KEY);
        const cursor = data && typeof data === 'object' && 'cursor' in data ? data.cursor : null;
        const order =
          typeof cursor === 'string' ? compareOrgCursors(cursor, latest?.cursor ?? null) : null;
        if (order === null || order > 0) {
          resync();
          return;
        }
      } catch {
        resync();
        return;
      }
      hasConnected = true;
      onStatus('live');
      clearTimeout(stableTimer);
      // A brief successful connection must not reset backoff during an outage.
      stableTimer = setTimeout(() => {
        if (currentConnection()) {
          attempt = 0;
          recoveryAttempted = false;
        }
      }, 10_000);
    };
    const patch = (event: Event) => {
      if (!currentConnection()) return;
      try {
        const input: unknown = JSON.parse((event as MessageEvent<string>).data);
        client.setQueryData<OrgSnapshot>(ORG_QUERY_KEY, (snapshot) =>
          snapshot ? applyLivePatch(snapshot, input) : snapshot,
        );
      } catch {
        resync();
      }
    };
    const reset = () => {
      if (currentConnection()) resync();
    };
    const error = () => {
      if (currentConnection()) retry();
    };
    const listeners = [
      ['ready', ready],
      ['patch', patch],
      ['resync', reset],
      ['error', error],
    ] as const;
    for (const [type, listener] of listeners) nextSource.addEventListener(type, listener);
    removeListeners = () => {
      for (const [type, listener] of listeners) nextSource.removeEventListener(type, listener);
    };
  };

  return {
    start() {
      if (!started && !disposed) {
        started = true;
        void connect();
      }
    },
    stop() {
      disposed = true;
      started = false;
      clearRetry();
      disconnect();
      cancelOwnedRecovery();
    },
    offline() {
      if (!disposed) {
        clearRetry();
        disconnect();
        cancelOwnedRecovery();
        onStatus('offline');
      }
    },
    online() {
      if (!disposed && started) {
        clearRetry();
        void connect();
      }
    },
  };
}

export function useLiveUpdates(enabled: boolean): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  useEffect(() => {
    if (!enabled) return;
    const connection = createLiveConnection({ onStatus: setStatus });
    window.addEventListener('offline', connection.offline);
    window.addEventListener('online', connection.online);
    connection.start();
    return () => {
      connection.stop();
      window.removeEventListener('offline', connection.offline);
      window.removeEventListener('online', connection.online);
    };
  }, [enabled]);
  return enabled ? status : 'connecting';
}
