import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveSearch } from './search.js';

const MAX_BODY_BYTES = 8 * 1024;

class SearchRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new Error('Search request aborted'));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new SearchRequestError(413, 'Размер запроса превышает 8 КиБ.'));
        // Drain the remaining body without storing it; keep the HTTP response usable.
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
        );
      } catch {
        reject(new SearchRequestError(400, 'Тело запроса должно содержать корректный JSON.'));
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    request.on('data', data);
    request.once('end', end);
  });
}

export async function handleSearchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  search: typeof resolveSearch = resolveSearch,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!response.writableFinished) abort();
  };
  request.once('aborted', abort);
  request.once('error', abort);
  response.once('close', closed);

  try {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      throw new SearchRequestError(405, 'Используйте метод POST.');
    }
    const mediaType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      throw new SearchRequestError(415, 'Ожидается Content-Type: application/json.');
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
      throw new SearchRequestError(413, 'Размер запроса превышает 8 КиБ.');
    }
    const body = await readBody(request, controller.signal);
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('query' in body) ||
      typeof body.query !== 'string' ||
      body.query.trim().length === 0 ||
      body.query.length > 500
    ) {
      throw new SearchRequestError(
        400,
        'Ожидается объект с единственным полем query: строкой от 1 до 500 символов.',
      );
    }
    const result = await search(body.query, { signal: controller.signal });
    if (!controller.signal.aborted) respond(response, 200, result);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof SearchRequestError)
      respond(response, error.status, { error: error.message });
    else respond(response, 500, { error: 'Не удалось обработать поисковый запрос.' });
    request.resume();
  } finally {
    request.off('aborted', abort);
    request.off('error', abort);
    response.off('close', closed);
  }
}
