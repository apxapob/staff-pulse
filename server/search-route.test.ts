import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppServer } from './app.js';
import { resolveSearch } from './search.js';
import { emptySearchFilter, type SearchResult } from '../src/search/filter.js';

const runningServers: Server[] = [];
const localSearch: typeof resolveSearch = (query, options) =>
  resolveSearch(query, { ...options, env: {} });

async function startServer(search: typeof resolveSearch = localSearch): Promise<string> {
  const server = createAppServer({ liveIntervalMs: 0, search });
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
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

function post(origin: string, body: unknown) {
  return fetch(`${origin}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('search HTTP route', () => {
  it('returns validated local filters and an honest literal text fallback', async () => {
    const origin = await startServer();
    const local = await post(origin, { query: 'Команды с эффективностью ниже 80%' });
    expect(local.status).toBe(200);
    expect(local.headers.get('Content-Type')).toContain('application/json');
    expect(local.headers.get('Cache-Control')).toBe('no-store');
    expect(await local.json()).toMatchObject({
      source: 'local',
      filter: {
        ...emptySearchFilter(),
        groups: [
          [
            { field: 'level', op: 'eq', value: 3 },
            { field: 'performance', op: 'lt', value: 80 },
          ],
        ],
      },
    });
    const fallback = await post(origin, { query: 'разработка' });
    expect(await fallback.json()).toMatchObject({
      source: 'text',
      filter: {
        ...emptySearchFilter(),
        groups: [[{ field: 'name', op: 'contains', value: 'разработка' }]],
      },
    });
  });

  it.each([
    {},
    null,
    [],
    { query: 3 },
    { query: '' },
    { query: '   ' },
    { query: 'x'.repeat(501) },
    { query: 'разработка', extra: true },
  ])('rejects an invalid request body: %j', async (body) => {
    const search = vi.fn<typeof resolveSearch>();
    const origin = await startServer(search);
    expect((await post(origin, body)).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('accepts a 500-character query and JSON media type with charset', async () => {
    const origin = await startServer();
    const response = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ query: 'я'.repeat(500) }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).filter.groups[0][0].value).toHaveLength(500);
  });

  it('rejects malformed JSON, unsupported media types, and non-POST methods', async () => {
    const search = vi.fn<typeof resolveSearch>();
    const origin = await startServer(search);
    const invalidJson = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    expect(invalidJson.status).toBe(400);
    const text = await fetch(`${origin}/api/search`, {
      method: 'POST',
      body: '{"query":"разработка"}',
    });
    expect(text.status).toBe(415);
    const wrongMethod = await fetch(`${origin}/api/search?query=ignored`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before calling the resolver', async () => {
    const search = vi.fn<typeof resolveSearch>();
    const origin = await startServer(search);
    const response = await post(origin, { query: 'я'.repeat(5_000) });
    expect(response.status).toBe(413);
    expect(search).not.toHaveBeenCalled();
  });

  it('enforces the byte limit for chunked requests without Content-Length', async () => {
    const search = vi.fn<typeof resolveSearch>();
    const origin = await startServer(search);
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${origin}/api/search`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode, body }));
          },
        );
        request.once('error', reject);
        request.write('{"query":"');
        request.write('я'.repeat(4_100));
        request.end('"}');
      },
    );
    expect(response.status).toBe(413);
    expect(response.body).toContain('8 КиБ');
    expect(search).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected resolver errors', async () => {
    const search = vi
      .fn<typeof resolveSearch>()
      .mockRejectedValue(new Error('Secret provider credential details'));
    const origin = await startServer(search);
    const response = await post(origin, { query: 'разработка' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Не удалось обработать поисковый запрос.' });
  });

  it('aborts the resolver when a client disconnects after uploading the body', async () => {
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal!: AbortSignal;
    const search: typeof resolveSearch = (_query, options) =>
      new Promise<SearchResult>((_resolve, reject) => {
        signal = options!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      });
    const origin = await startServer(search);
    const request = httpRequest(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify({ query: 'разработка' }));
    await resolverStarted;
    expect(signal.aborted).toBe(false);
    request.destroy();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  });

  it('does not invoke the resolver for an aborted partial body', async () => {
    const search = vi.fn<typeof resolveSearch>();
    const origin = await startServer(search);
    const request = httpRequest(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    await new Promise<void>((resolve) => {
      request.write('{"query":"unfinished', () => resolve());
    });
    request.destroy();
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
    expect(search).not.toHaveBeenCalled();
  });
});
