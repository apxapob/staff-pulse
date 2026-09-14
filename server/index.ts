import { createAppServer, readLiveInterval, readServerPort } from './app.js';

const port = readServerPort();
const server = createAppServer({ liveIntervalMs: readLiveInterval() });

server.on('error', (error: Error) => {
  console.error(`Staff Pulse API failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '0.0.0.0', () => {
  console.info(`Staff Pulse API listening on http://0.0.0.0:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      process.exitCode = 0;
    });
    server.closeIdleConnections();
  });
}
