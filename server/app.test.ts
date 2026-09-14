import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppServer, readServerPort } from './app.js';
import { getFreshOrgTree } from './data.js';

const runningServers: Server[] = [];

async function startServer(): Promise<string> {
  const server = createAppServer();
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
      (server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    ),
  );
});

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
