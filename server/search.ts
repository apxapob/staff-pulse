import {
  emptySearchFilter,
  parseSearchFilter,
  type SearchFilter,
  type SearchResult,
} from '../src/search/filter.js';

import { parseLocalSearch } from './local-search.js';
import { searchInstructions, searchResponseSchema } from './search-schema.js';
export { parseLocalSearch } from './local-search.js';

export interface SearchOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function textSearch(query: string, explanation: string): SearchResult {
  return {
    filter: { ...emptySearchFilter(), groups: [[{ field: 'name', op: 'contains', value: query }]] },
    source: 'text',
    explanation,
  };
}

function readStructuredFilter(text: string): SearchFilter {
  const result: unknown = JSON.parse(text);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('supported' in result) ||
    result.supported !== true ||
    !('filter' in result) ||
    Object.keys(result).length !== 2
  ) {
    throw new TypeError('Unsupported AI search query.');
  }
  const filter = parseSearchFilter(result.filter);
  if (filter.groups.length === 0 && filter.sort === null && filter.limit === null) {
    throw new TypeError('Empty AI filter.');
  }
  return filter;
}

function readAIOutput(value: unknown): SearchFilter {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('output' in value) ||
    !('status' in value) ||
    value.status !== 'completed' ||
    !Array.isArray(value.output)
  ) {
    throw new TypeError('Incomplete AI search response.');
  }
  const text = value.output
    .flatMap((item: unknown) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('type' in item) ||
        item.type !== 'message' ||
        !('content' in item) ||
        !Array.isArray(item.content)
      )
        return [];
      return item.content.flatMap((part: unknown) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'output_text' &&
        'text' in part &&
        typeof part.text === 'string'
          ? [part.text]
          : [],
      );
    })
    .join('');
  return readStructuredFilter(text);
}

function readOllamaOutput(value: unknown): SearchFilter {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('done' in value) ||
    value.done !== true ||
    !('done_reason' in value) ||
    value.done_reason !== 'stop' ||
    !('message' in value) ||
    typeof value.message !== 'object' ||
    value.message === null ||
    !('role' in value.message) ||
    value.message.role !== 'assistant' ||
    !('content' in value.message) ||
    typeof value.message.content !== 'string'
  ) {
    throw new TypeError('Incomplete local model search response.');
  }
  return readStructuredFilter(value.message.content);
}

export function readProvider(env: NodeJS.ProcessEnv): 'local' | 'ollama' | 'openai' {
  const provider = env.SEARCH_PROVIDER?.trim() || (env.AI_API_KEY?.trim() ? 'openai' : 'local');
  if (provider !== 'local' && provider !== 'ollama' && provider !== 'openai') {
    throw new TypeError('Invalid search provider.');
  }
  return provider;
}

function readTimeout(env: NodeJS.ProcessEnv, provider: 'ollama' | 'openai', override?: number) {
  const value = override ?? (env.AI_TIMEOUT_MS?.trim() ? Number(env.AI_TIMEOUT_MS) : undefined);
  if (value === undefined) return provider === 'ollama' ? 30_000 : 5_000;
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new TypeError('Invalid search timeout.');
  }
  return value;
}

export function readOllamaConfig(env: NodeJS.ProcessEnv) {
  const url = new URL(env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new TypeError('Invalid local model URL.');
  }
  const model = env.OLLAMA_MODEL?.trim() || 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0';
  if (
    model.length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(model)
  ) {
    throw new TypeError('Invalid local model name.');
  }
  return { url: new URL('/api/chat', url).href, model };
}

/** The deadline also covers body reads and transports that do not reject on abort. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function resolveSearch(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > 500) {
    throw new TypeError('Введите запрос длиной от 1 до 500 символов.');
  }
  const normalizedQuery = query.trim();
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let provider: 'local' | 'ollama' | 'openai' | undefined;
  try {
    provider = readProvider(env);
    if (provider === 'local') {
      const filter = parseLocalSearch(normalizedQuery);
      return filter
        ? { filter, source: 'local', explanation: 'Фраза распознана локально, без обращения к AI.' }
        : textSearch(normalizedQuery, 'Поиск по названию. Для сложных фраз можно подключить AI.');
    }
    const timeoutMs = readTimeout(env, provider, options.timeoutMs);
    const ollama = provider === 'ollama' ? readOllamaConfig(env) : undefined;
    const key = provider === 'openai' ? env.AI_API_KEY?.trim() : undefined;
    if (provider === 'openai' && !key) throw new TypeError('Missing AI provider key.');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const request = (async () => {
      const response = await (options.fetch ?? globalThis.fetch)(
        ollama?.url ?? 'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: ollama
            ? { 'Content-Type': 'application/json' }
            : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(
            ollama
              ? {
                  model: ollama.model,
                  stream: false,
                  think: false,
                  keep_alive: '10m',
                  format: searchResponseSchema,
                  options: { temperature: 0, num_ctx: 4096, num_predict: 2048 },
                  messages: [
                    { role: 'system', content: searchInstructions },
                    { role: 'user', content: normalizedQuery },
                  ],
                }
              : {
                  model: env.AI_MODEL?.trim() || 'gpt-4.1-mini',
                  store: false,
                  max_output_tokens: 2048,
                  instructions: searchInstructions,
                  input: normalizedQuery,
                  text: {
                    format: {
                      type: 'json_schema',
                      name: 'organization_search',
                      strict: true,
                      schema: searchResponseSchema,
                    },
                  },
                },
          ),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('AI search request failed.');
      }
      const body: unknown = await response.json();
      controller.signal.throwIfAborted();
      return ollama ? readOllamaOutput(body) : readAIOutput(body);
    })();
    const filter = await abortable(request, controller.signal);
    return {
      filter,
      source: 'ai',
      explanation:
        provider === 'ollama'
          ? 'Локальная модель преобразовала фразу в фильтр по подразделениям.'
          : 'AI преобразовал фразу в фильтр по подразделениям.',
    };
  } catch {
    options.signal?.throwIfAborted();
    return textSearch(
      normalizedQuery,
      provider === 'ollama'
        ? 'Локальная модель недоступна или не распознала фразу. Выполнен поиск по названию.'
        : 'AI-поиск недоступен или не распознал фразу. Выполнен поиск по названию.',
    );
  } finally {
    controller.abort();
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
