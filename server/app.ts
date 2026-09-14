import { createServer, type Server, type ServerResponse } from 'node:http';
import { getFreshOrgTree, type OrgNode } from './data.js';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export interface AppServerOptions {
  nodes?: OrgNode[];
}

export function createAppServer({ nodes = getFreshOrgTree() }: AppServerOptions = {}): Server {
  return createServer((request, response) => {
    const path = request.url?.split('?')[0];

    if (path !== '/api/org-tree') {
      sendJson(response, 404, { error: 'Endpoint not found' });
      return;
    }

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    sendJson(response, 200, nodes);
  });
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
