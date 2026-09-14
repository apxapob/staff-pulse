import { describe, expect, it, vi } from 'vitest';
import { emptySearchFilter, type SearchCondition, type SearchFilter } from '../src/search/filter';
import { resolveSearch } from './search';

const configuredEnv = { AI_API_KEY: 'test-only-placeholder', AI_MODEL: 'gpt-4.1-mini' };
const and = (...conditions: SearchCondition[]): SearchFilter => ({
  ...emptySearchFilter(),
  groups: [conditions],
});
const textFilter = (name: string) => and({ field: 'name', op: 'contains', value: name });
const below80 = and(
  { field: 'level', op: 'eq', value: 3 },
  { field: 'performance', op: 'lt', value: 80 },
);
const aiResponse = (payload: unknown, status = 'completed') =>
  Response.json({
    status,
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] },
    ],
  });

const ollamaEnv = { SEARCH_PROVIDER: 'ollama' };
const ollamaResponse = (payload: unknown, extra: Record<string, unknown> = {}) =>
  Response.json({
    done: true,
    done_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify(payload) },
    ...extra,
  });

describe('local Ollama model search', () => {
  it('uses the selected default model and structured chat without sending cloud credentials or organization data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ollamaResponse({ supported: true, filter: below80 }));
    const query = 'Покажи команды с эффективностью ниже 80%';
    const result = await resolveSearch(query, { env: { ...configuredEnv, ...ollamaEnv }, fetch });
    expect(result).toMatchObject({ source: 'ai', filter: below80 });
    expect(result.explanation).toContain('Локальная модель');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(request?.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0',
      stream: false,
      think: false,
      keep_alive: '10m',
      format: { type: 'object', additionalProperties: false, required: ['supported', 'filter'] },
      options: { temperature: 0, num_ctx: 4096, num_predict: 2048 },
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: query },
      ],
    });
    expect(Object.keys(body).sort()).toEqual(
      ['model', 'stream', 'think', 'keep_alive', 'format', 'options', 'messages'].sort(),
    );
    expect(body.messages).toHaveLength(2);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(configuredEnv.AI_API_KEY);
    expect(JSON.stringify(result)).not.toContain(configuredEnv.AI_API_KEY);
  });

  it('honors the configured model and container URL', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ollamaResponse({ supported: true, filter: below80 }));
    await resolveSearch('Команды с эффективностью ниже 80%', {
      env: { ...ollamaEnv, OLLAMA_URL: 'http://ollama:11434/', OLLAMA_MODEL: 'qwen3.5:0.8b' },
      fetch,
    });
    expect(fetch.mock.calls[0][0]).toBe('http://ollama:11434/api/chat');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe('qwen3.5:0.8b');
  });

  it.each([
    { supported: false, filter: emptySearchFilter() },
    { supported: true, filter: emptySearchFilter() },
    { supported: true, filter: { ...below80, expression: 'process.env' } },
    {
      supported: true,
      filter: { ...below80, groups: [[{ field: 'headcount', op: 'gt', value: -1 }]] },
    },
    {
      supported: true,
      filter: { ...below80, groups: [[{ field: 'budget', op: 'gt', value: '5 млн' }]] },
    },
    { supported: true, filter: { ...below80, groups: [[{ field: 'level', op: 'eq', value: 4 }]] } },
    {
      supported: true,
      filter: { ...below80, groups: [[{ field: 'name', op: 'eq', value: 'x' }]] },
    },
    { supported: true, filter: { ...below80, groups: [[]] } },
    {
      supported: true,
      filter: { ...below80, groups: Array.from({ length: 9 }, () => below80.groups[0]) },
    },
    {
      supported: true,
      filter: { ...below80, groups: [Array.from({ length: 9 }, () => below80.groups[0][0])] },
    },
    { supported: true, filter: { ...below80, sort: { field: 'budget', direction: 'down' } } },
    { supported: true, filter: { ...below80, limit: 1001 } },
    { supported: true, filter: { groups: below80.groups } },
    { supported: true, filter: below80, extra: true },
  ])(
    'rejects unsupported or schema-invalid output without a cloud fallback: %j',
    async (payload) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ollamaResponse(payload));
      const query = 'Команды с эффективностью ниже 80% и офисом в Москве';
      expect(
        await resolveSearch(query, { env: { ...configuredEnv, ...ollamaEnv }, fetch }),
      ).toMatchObject({ source: 'text', filter: textFilter(query) });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
    },
  );

  it.each([
    { groups: [], sort: { field: 'name', direction: 'asc' }, limit: null },
    { groups: [], sort: null, limit: 3 },
    {
      groups: [
        [
          { field: 'headcount', op: 'gte', value: 10 },
          { field: 'headcount', op: 'lte', value: 20 },
        ],
        [
          { field: 'level', op: 'ne', value: 3 },
          { field: 'name', op: 'notContains', value: 'Продажи' },
        ],
      ],
      sort: { field: 'budget', direction: 'desc' },
      limit: 5,
    },
  ])(
    'preserves complete model filters including ranges, OR, exclusions, sorting and limits',
    async (filter) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(ollamaResponse({ supported: true, filter }));
      expect(
        await resolveSearch('Выбери три отдела с самым большим бюджетом', {
          env: ollamaEnv,
          fetch,
        }),
      ).toMatchObject({ source: 'ai', filter });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    () => new Response('private runtime details', { status: 500 }),
    () => new Response('{not json}'),
    () => ollamaResponse({ supported: true, filter: below80 }, { done: false }),
    () => ollamaResponse({ supported: true, filter: below80 }, { done_reason: 'length' }),
    () => ollamaResponse({ supported: true, filter: below80 }, { message: {} }),
    () =>
      ollamaResponse(null, {
        message: { role: 'assistant', content: '```json\n{"supported": true}\n```' },
      }),
  ])('rejects failed, malformed or incomplete model responses', async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const result = await resolveSearch('разработка', { env: ollamaEnv, fetch });
    expect(result).toMatchObject({
      source: 'text',
      filter: textFilter('разработка'),
    });
    expect(result.explanation).toContain('Локальная модель');
    expect(JSON.stringify(result)).not.toContain('private runtime details');
  });

  it('does not expose connection errors or try cloud credentials after a local model failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('private path'));
    const result = await resolveSearch('разработка', {
      env: { ...configuredEnv, ...ollamaEnv },
      fetch,
    });
    expect(result.source).toBe('text');
    expect(JSON.stringify(result)).not.toMatch(/private path|test-only-placeholder/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels an unfinished HTTP error body and releases the provider request before falling back', async () => {
    const cancel = vi.fn();
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
      signal = options?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('private provider error'));
          },
          cancel,
        }),
        { status: 503 },
      );
    });
    const result = await resolveSearch('разработка', { env: ollamaEnv, fetch });
    expect(result.source).toBe('text');
    expect(JSON.stringify(result)).not.toContain('private provider error');
    expect(cancel).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { SEARCH_PROVIDER: 'unknown' },
    { SEARCH_PROVIDER: 'openai' },
    { ...ollamaEnv, OLLAMA_URL: 'file:///private/file' },
    { ...ollamaEnv, OLLAMA_URL: 'http://user:secret@localhost:11434' },
    { ...ollamaEnv, OLLAMA_URL: 'http://localhost:11434/?token=secret' },
    { ...ollamaEnv, OLLAMA_MODEL: 'invalid model' },
    { ...ollamaEnv, AI_TIMEOUT_MS: '0' },
    { ...ollamaEnv, AI_TIMEOUT_MS: 'NaN' },
    { ...ollamaEnv, AI_TIMEOUT_MS: '120001' },
  ])('fails safely before any request with invalid provider configuration: %j', async (env) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await resolveSearch('разработка', { env, fetch });
    expect(result.source).toBe('text');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['ollama', 'openai'])(
    'applies the configured deadline to a stalled %s body read',
    async (provider) => {
      vi.useFakeTimers();
      try {
        const response = new Response();
        const readBody = vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
        const pending = resolveSearch('разработка', {
          env: { ...configuredEnv, SEARCH_PROVIDER: provider, AI_TIMEOUT_MS: '25' },
          fetch,
        });
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toMatchObject({ source: 'text' });
        expect(readBody).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('propagates caller cancellation during body reading', async () => {
    const controller = new AbortController();
    const response = new Response();
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(response, 'json').mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const pending = resolveSearch('разработка', {
      env: ollamaEnv,
      fetch,
      signal: controller.signal,
    });
    await bodyStarted;
    controller.abort(new Error('Search cancelled'));
    await expect(pending).rejects.toThrow('Search cancelled');
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('rejects a previously cancelled request without contacting the model', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already cancelled'));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      resolveSearch('разработка', { env: ollamaEnv, fetch, signal: controller.signal }),
    ).rejects.toThrow('Already cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('optional OpenAI search', () => {
  it('requests validated structured JSON from the provider without sending organization data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(aiResponse({ supported: true, filter: below80 }));
    const result = await resolveSearch('Команды с эффективностью ниже 80%', {
      env: configuredEnv,
      fetch,
    });
    expect(result).toMatchObject({ source: 'ai', filter: below80 });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request?.headers).toEqual({
      Authorization: 'Bearer test-only-placeholder',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: 'gpt-4.1-mini',
      store: false,
      input: 'Команды с эффективностью ниже 80%',
      text: {
        format: { type: 'json_schema', strict: true, schema: { additionalProperties: false } },
      },
    });
    expect(body).not.toHaveProperty('nodes');
    expect(JSON.stringify(result)).not.toContain('test-only-placeholder');
  });

  it.each([
    { supported: false, filter: emptySearchFilter() },
    { supported: true, filter: emptySearchFilter() },
    { supported: true, filter: { ...below80, expression: 'true' } },
    { supported: true, filter: { ...below80, budget: { op: 'gt', value: '5 млн' } } },
    { supported: true, filter: below80, extra: true },
  ])('rejects unsupported or invalid provider output: %j', async (payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(aiResponse(payload));
    expect(await resolveSearch('исходный запрос', { env: configuredEnv, fetch })).toMatchObject({
      source: 'text',
      filter: textFilter('исходный запрос'),
    });
  });

  it.each([
    () => new Response('Rate limited', { status: 429 }),
    () => new Response('{not json}', { status: 200 }),
    () => aiResponse({ supported: true, filter: below80 }, 'incomplete'),
    () =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }],
      }),
  ])(
    'returns text search after an HTTP, malformed, incomplete or refused response',
    async (response) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
      expect(await resolveSearch('разработка', { env: configuredEnv, fetch })).toMatchObject({
        source: 'text',
        filter: textFilter('разработка'),
      });
    },
  );

  it('falls back after a network failure without disclosing the provider error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('private provider details'));
    const result = await resolveSearch('разработка', { env: configuredEnv, fetch });
    expect(result.source).toBe('text');
    expect(JSON.stringify(result)).not.toContain('private provider details');
  });

  it('aborts a stalled provider call after the configured timeout and falls back', async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        }),
    );
    const result = await resolveSearch('разработка', { env: configuredEnv, fetch, timeoutMs: 5 });
    expect(signal?.aborted).toBe(true);
    expect(result.source).toBe('text');
  });

  it('propagates caller cancellation and aborts the provider', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const result = resolveSearch('разработка', {
      env: configuredEnv,
      fetch,
      signal: controller.signal,
    });
    controller.abort(new Error('Search cancelled'));
    await expect(result).rejects.toThrow('Search cancelled');
  });

  it.each(['', '   ', 'a'.repeat(501)])(
    'rejects invalid queries before contacting the provider',
    async (query) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(resolveSearch(query, { env: configuredEnv, fetch })).rejects.toThrow(TypeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
