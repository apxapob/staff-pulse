import { parseSearchStatus, type SearchStatus } from '../src/search/status.js';
import { abortable, readOllamaConfig, readProvider, type SearchOptions } from './search.js';

function managerStatusUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new TypeError('Invalid model status URL.');
  }
  return new URL('/status', url).href;
}

function readManagerStatus(value: unknown, model: string): SearchStatus {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'model') ||
    !Object.hasOwn(value, 'status') ||
    !('model' in value) ||
    value.model !== model ||
    !('status' in value)
  ) {
    throw new TypeError('Invalid model preparation status.');
  }
  const status = parseSearchStatus({ status: value.status });
  if (status.status === 'unavailable') throw new TypeError('Invalid preparation state.');
  return status;
}

/** Readiness is independent of search inference and has its own short deadline. */
export async function resolveSearchStatus(options: SearchOptions = {}): Promise<SearchStatus> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (readProvider(env) !== 'ollama') return { status: 'ready' };
    const ollama = readOllamaConfig(env);
    const manager = env.MODEL_STATUS_URL?.trim();
    const url = manager ? managerStatusUrl(manager) : new URL('/api/show', ollama.url).href;
    const timeoutMs = options.timeoutMs ?? 1000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
      throw new TypeError('Invalid status timeout.');
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const request = (async (): Promise<SearchStatus> => {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: manager ? 'GET' : 'POST',
        ...(manager
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: ollama.model }),
            }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (!manager && response.status === 404) return { status: 'error' };
        throw new Error('Status service unavailable.');
      }
      const body: unknown = await response.json();
      controller.signal.throwIfAborted();
      if (manager) return readManagerStatus(body, ollama.model);
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        !('modelfile' in body) ||
        typeof body.modelfile !== 'string' ||
        !body.modelfile.trim() ||
        'error' in body
      ) {
        throw new TypeError('Invalid model metadata.');
      }
      return { status: 'ready' };
    })();
    return await abortable(request, controller.signal);
  } catch {
    options.signal?.throwIfAborted();
    return { status: 'unavailable' };
  } finally {
    controller.abort();
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
