import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getFreshOrgTree, type OrgNode } from './data.js';
import { OrgStore } from './org-store.js';
import { formatEvent, SseConnection } from './sse.js';
import { handleSearchRequest } from './search-route.js';
import type { resolveSearch } from './search.js';
import { resolveSearchStatus } from './search-status.js';
import { parseSearchStatus } from '../src/search/status.js';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function sendSearchStatus(
  request: IncomingMessage,
  response: ServerResponse,
  resolveStatus: typeof resolveSearchStatus,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!response.writableFinished) abort();
  };
  request.once('aborted', abort);
  request.once('error', abort);
  response.once('close', closed);
  const respond = (body: unknown) => {
    if (!controller.signal.aborted && !response.destroyed && !response.writableEnded)
      sendJson(response, 200, body);
  };
  try {
    respond(parseSearchStatus(await resolveStatus({ signal: controller.signal })));
  } catch {
    respond({ status: 'unavailable' });
  } finally {
    request.off('aborted', abort);
    request.off('error', abort);
    response.off('close', closed);
  }
}

export interface AppServerOptions {
  nodes?: OrgNode[];
  store?: OrgStore;
  /** Set to zero to disable automatic updates in deterministic tests. */
  liveIntervalMs?: number;
  heartbeatIntervalMs?: number;
  search?: typeof resolveSearch;
  searchStatus?: typeof resolveSearchStatus;
}

export function createAppServer({
  nodes = getFreshOrgTree(),
  store = new OrgStore({ nodes }),
  liveIntervalMs = 8_000,
  heartbeatIntervalMs = 15_000,
  search,
  searchStatus = resolveSearchStatus,
}: AppServerOptions = {}): Server {
  const connections = new Set<SseConnection>();
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }
    const path = url.pathname;

    if (path === '/api/search') {
      void handleSearchRequest(request, response, search);
      return;
    }

    if (!['/api/org-tree', '/api/org-events', '/api/health', '/api/search/status'].includes(path)) {
      sendJson(response, 404, { error: 'Endpoint not found' });
      return;
    }

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    if (path === '/api/search/status') {
      void sendSearchStatus(request, response, searchStatus);
      return;
    }

    if (path === '/api/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (path === '/api/org-tree') {
      const snapshot = store.snapshot();
      const etag = `"${snapshot.cursor}"`;
      response.setHeader('X-Org-Cursor', snapshot.cursor);
      response.setHeader('ETag', etag);
      const matches = request.headers['if-none-match']?.split(',').map((entry) => entry.trim());
      if (matches?.some((entry) => entry === '*' || entry.replace(/^W\//, '') === etag)) {
        response.writeHead(304, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendJson(response, 200, snapshot.nodes);
      return;
    }

    const lastEventId = request.headers['last-event-id'];
    const cursor =
      (typeof lastEventId === 'string' ? lastEventId : undefined) ||
      url.searchParams.get('cursor') ||
      undefined;
    const replay = store.replay(cursor);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    if (!replay.ok) {
      response.end(formatEvent('resync', { reason: replay.reason }));
      return;
    }

    const connection = new SseConnection(response);
    connections.add(connection);
    const unsubscribe = store.subscribe((patch) =>
      connection.send(formatEvent('patch', patch, patch.cursor)),
    );
    connection.setDisposeCallback(() => {
      unsubscribe();
      connections.delete(connection);
    });
    // Registration and replay are synchronous: no commit can be missed between them.
    for (const patch of replay.patches) connection.send(formatEvent('patch', patch, patch.cursor));
    connection.send(formatEvent('ready', { cursor: replay.cursor }, replay.cursor));
  });

  server.once('listening', () => {
    if (liveIntervalMs > 0) liveTimer = setInterval(() => store.advanceDemo(), liveIntervalMs);
    heartbeatTimer = setInterval(() => {
      for (const connection of connections) connection.send(': heartbeat\n\n');
    }, heartbeatIntervalMs);
    liveTimer?.unref();
    heartbeatTimer.unref();
  });

  const close = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(liveTimer);
    clearInterval(heartbeatTimer);
    for (const connection of connections) connection.close();
    return close(callback);
  };
  return server;
}

export function readServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.PORT?.trim() ?? '3001';

  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

export function readLiveInterval(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.LIVE_INTERVAL_MS?.trim() ?? '8000';
  const interval = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(interval) ||
    interval < 1_000 ||
    interval > 3_600_000
  ) {
    throw new Error('LIVE_INTERVAL_MS must be an integer between 1000 and 3600000');
  }
  return interval;
}
