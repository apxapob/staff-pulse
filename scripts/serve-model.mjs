import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { defaultModel, prepareModel } from './prepare-model.mjs';

export function createModelServer({
  model = process.env.OLLAMA_MODEL ?? defaultModel,
  prepare = prepareModel,
  logError = console.error,
} = {}) {
  let status = 'preparing';
  let finished = false;
  const controller = new AbortController();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url?.split('?')[0] !== '/status') {
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    } else if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' }));
    } else {
      response.end(JSON.stringify({ model, status }));
    }
  });

  // Open the status endpoint first; model download and warmup must not delay the app.
  server.once('listening', () => {
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return prepare({
          model,
          signal: controller.signal,
          onStatus: (phase) => {
            if (
              !finished &&
              !controller.signal.aborted &&
              ['downloading', 'warming'].includes(phase)
            )
              status = phase;
          },
        });
      })
      .then(() => {
        finished = true;
        if (!controller.signal.aborted) status = 'ready';
      })
      .catch((error) => {
        finished = true;
        if (controller.signal.aborted) return;
        status = 'error';
        logError(`Model preparation failed: ${error instanceof Error ? error.message : error}`);
      });
  });
  server.once('close', () => controller.abort());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createModelServer();
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
  server.once('error', (error) => {
    console.error(`Model status server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(3002, '0.0.0.0');
}
