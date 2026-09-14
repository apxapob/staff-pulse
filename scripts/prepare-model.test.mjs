import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareModel } from './prepare-model.mjs';

const model = 'hf.co/test/model:smallest';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function progress(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  );
}

function harness(responses, selectedModel = model) {
  const requests = [];
  const messages = [];
  const delays = [];
  const statuses = [];
  return {
    requests,
    messages,
    delays,
    statuses,
    run: (options = {}) =>
      prepareModel({
        ...options,
        url: 'http://ollama:11434/',
        model: selectedModel,
        log: (message) => messages.push(message),
        delayImpl: async (milliseconds) => delays.push(milliseconds),
        onStatus: (status) => statuses.push(status),
        fetchImpl: async (url, options) => {
          const request = {
            url,
            method: options.method ?? 'GET',
            body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
          };
          requests.push(request);
          if (options.body instanceof ReadableStream) {
            request.uploaded = new Uint8Array(await new Response(options.body).arrayBuffer());
            assert.equal(options.duplex, 'half');
            assert.equal(options.headers['Content-Length'], String(request.uploaded.length));
          }
          assert.ok(options.signal instanceof AbortSignal);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          assert.ok(response, `Unexpected request: ${url}`);
          return response;
        },
      }),
  };
}

test('downloads a missing model and reports ready only after successfully loading it', async () => {
  const { run, requests, messages, statuses } = harness([
    json({ error: 'not found' }, 404),
    progress([
      '{"status":"pulling manifest"}\n{"status":"pulling layer","total":100,"completed":',
      '60}\n{"status":"success"}',
    ]),
    json({ done: true, eval_count: 1 }),
  ]);

  await run();

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    ['/api/show', '/api/pull', '/api/generate'],
  );
  assert.ok(requests.every(({ body }) => body.model === model));
  const prompt = requests[2].body.prompt;
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length >= 3000 && prompt.length <= 5000);
  assert.ok(prompt.startsWith('This is a synthetic startup readiness check.'));
  assert.deepEqual(requests[2].body, {
    model,
    prompt,
    raw: true,
    think: false,
    stream: false,
    keep_alive: -1,
    options: { num_ctx: 4096, num_predict: 1, temperature: 0 },
  });
  assert.ok(messages.includes('pulling layer 60%'));
  assert.equal(messages.at(-1), `Model ready: ${model}`);
  assert.deepEqual(statuses, ['downloading', 'warming']);
});

test('an offline cached model is loaded without contacting a registry', async () => {
  const { run, requests, messages, statuses } = harness([
    json({ details: {} }),
    json({ done: true, eval_count: 1 }),
  ]);

  await run();

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    ['/api/show', '/api/generate'],
  );
  assert.ok(messages.includes('Using the cached model; no download needed.'));
  assert.deepEqual(statuses, ['warming']);
});

test('readiness waits for prompt evaluation and actual generation even with a cached model', async () => {
  let finishWarmup;
  const warmup = new Promise((resolve) => {
    finishWarmup = resolve;
  });
  const { run, requests, messages, statuses } = harness([json({ details: {} }), warmup]);
  const preparing = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
  assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
  assert.deepEqual(statuses, ['warming']);
  finishWarmup(json({ done: true, eval_count: 1 }));
  await preparing;
  assert.equal(messages.at(-1), `Model ready: ${model}`);
});

test('a server error checking the cache does not trigger a download', async () => {
  const { run, requests, statuses } = harness([json({ error: 'unavailable' }, 500)]);
  await assert.rejects(run(), /Checking the model cache failed \(HTTP 500\)/);
  assert.equal(requests.length, 1);
  assert.deepEqual(statuses, []);
});

test('aborting a pending download cancels its request without retrying or warming', async () => {
  const controller = new AbortController();
  const statuses = [];
  const requests = [];
  let downloadStarted;
  const started = new Promise((resolve) => {
    downloadStarted = resolve;
  });
  let downloadSignal;
  const preparing = prepareModel({
    model,
    signal: controller.signal,
    log: () => {},
    onStatus: (status) => statuses.push(status),
    delayImpl: () => assert.fail('An aborted download must not retry'),
    fetchImpl: async (url, options) => {
      requests.push(url);
      if (url.endsWith('/api/show')) return json({ error: 'not found' }, 404);
      downloadSignal = options.signal;
      downloadStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
  });
  await started;
  controller.abort(new Error('shutdown'));
  await assert.rejects(preparing, /shutdown/);
  assert.equal(downloadSignal.aborted, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(statuses, ['downloading']);
});

test('abort cancels the retry backoff instead of keeping model preparation alive', async () => {
  const controller = new AbortController();
  let requests = 0;
  let backoffStarted;
  const started = new Promise((resolve) => {
    backoffStarted = resolve;
  });
  const preparing = prepareModel({
    model,
    signal: controller.signal,
    log: (message) => {
      if (message.includes('Retrying in')) backoffStarted();
    },
    fetchImpl: async () =>
      ++requests === 1
        ? json({ error: 'not found' }, 404)
        : json({ error: 'temporary failure' }, 503),
  });
  await started;
  controller.abort();
  await assert.rejects(preparing, /abort/i);
  assert.equal(requests, 2);
});

for (const [name, response, expected] of [
  ['HTTP failure', json({ error: 'not found' }, 404), /Model download failed \(HTTP 404\)/],
  [
    'HTTP 404 wrapped in a 200 stream',
    progress([
      JSON.stringify({ error: 'pull model manifest: 404: network model not found' }) + '\n',
    ]),
    /404/,
  ],
  ['stream error', progress(['{"error":"invalid model"}\n']), /invalid model/],
  ['invalid JSON', progress(['not-json\n']), /JSON/],
  ['malformed progress', progress(['{"unknown":"progress"}\n']), /Invalid model download progress/],
]) {
  test(`model download ${name} prevents startup`, async () => {
    const { run, requests, messages, delays } = harness([json({}, 404), response]);
    await assert.rejects(run(), expected);
    assert.equal(requests.length, 2);
    assert.deepEqual(delays, []);
    assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
  });
}

for (const [name, createResponse, expected] of [
  ['HF stream timeout', () => progress(['{"error":"context deadline exceeded"}\n']), /deadline/],
  ['HTTP service unavailable', () => json({ error: 'unavailable' }, 503), /HTTP 503/],
  ...[408, 425, 429, 500, 503, 504].map((status) => [
    `registry HTTP ${status} wrapped in a 200 stream`,
    () =>
      progress([
        JSON.stringify({
          error: `pull model manifest: ${status}: {"error":"Internal Error - We're working hard to fix this as soon as possible!"}`,
        }) + '\n',
      ]),
    new RegExp(String(status)),
  ]),
  [
    'interrupted stream',
    () => progress(['{"status":"pulling manifest"}\n']),
    /ended before success/,
  ],
  ['empty stream', () => progress([]), /ended before success/],
  ['connection failure', () => new Error('socket closed'), /socket closed/],
  [
    'broken response connection',
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
          },
        }),
      ),
    /terminated/,
  ],
  ['fetch timeout', () => new DOMException('timed out', 'TimeoutError'), /timed out/],
]) {
  test(`transient model download ${name} stops after three attempts without reporting ready`, async () => {
    const { run, requests, messages, delays } = harness([
      json({}, 404),
      createResponse(),
      createResponse(),
      createResponse(),
    ]);
    await assert.rejects(run(), expected);
    assert.equal(requests.length, 4);
    assert.deepEqual(delays, [2000, 4000]);
    assert.ok(requests.slice(1).every(({ url }) => new URL(url).pathname === '/api/pull'));
    assert.ok(messages.includes('Model download attempt 3/3'));
    assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
  });
}

test('retries a transient HF error in a 200 stream and loads only after a successful resumed pull', async () => {
  const { run, requests, messages, delays } = harness([
    json({}, 404),
    progress([
      '{"status":"pulling weights","total":100,"completed":100}\n',
      '{"error":"context deadline exceeded"}\n',
    ]),
    progress(['{"status":"verifying sha256 digest"}\n{"status":"success"}\n']),
    json({ done: true, eval_count: 1 }),
  ]);

  await run();

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    ['/api/show', '/api/pull', '/api/pull', '/api/generate'],
  );
  assert.deepEqual(requests[1].body, requests[2].body);
  assert.deepEqual(delays, [2000]);
  assert.equal(messages.at(-1), `Model ready: ${model}`);
});

const directModel = 'hf.co/unsloth/Qwen3.5-2B-GGUF:Q4_K_M';
const gemmaModel = 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M';
const revision = 'b'.repeat(40);
const ggufDigest = `sha256:${'a'.repeat(64)}`;
const ggufFile = {
  type: 'file',
  path: 'Qwen3.5-2B-Q4_K_M.gguf',
  size: 4,
  lfs: { oid: 'a'.repeat(64), size: 4 },
};

for (const newline of ['\n', '\r\n']) {
  test(`a cached native Qwen model starts offline with ${JSON.stringify(newline)} modelfile lines`, async () => {
    const { run, requests, delays } = harness(
      [
        json({
          modelfile: ['FROM /cache/model', 'RENDERER qwen3.5', 'PARSER qwen3.5', ''].join(newline),
        }),
        json({ done: true, eval_count: 1 }),
      ],
      directModel,
    );
    await run();
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).pathname),
      ['/api/show', '/api/generate'],
    );
    assert.deepEqual(delays, []);
  });
}

for (const [name, details] of [
  ['registry configuration', { modelfile: 'FROM /cache/model\nTEMPLATE {{ .Prompt }}' }],
  ['absent parser', { modelfile: 'RENDERER qwen3.5\n' }],
  ['another renderer', { modelfile: 'RENDERER qwen3\nPARSER qwen3.5\n' }],
  ['renderer suffix', { modelfile: 'RENDERER qwen3.5-extra\nPARSER qwen3.5\n' }],
  ['prefixed instructions', { modelfile: '# RENDERER qwen3.5\n# PARSER qwen3.5\n' }],
  ['top-level fields only', { renderer: 'qwen3.5', parser: 'qwen3.5' }],
]) {
  test(`a cached Qwen model with ${name} is reimported before loading`, async () => {
    const { run, requests, messages } = harness(
      [
        json(details),
        json({ sha: revision }),
        json([ggufFile]),
        json({}),
        json({ status: 'success' }),
        json({ done: true, eval_count: 1 }),
      ],
      directModel,
    );
    await run();
    assert.equal(requests[4].url, 'http://ollama:11434/api/create');
    assert.equal(requests[5].url, 'http://ollama:11434/api/generate');
    assert.ok(requests.every(({ url }) => !url.endsWith('/api/pull')));
    assert.ok(messages.some((message) => message.startsWith('Updating the cached model')));
  });
}

function failedRegistry() {
  return [
    json({}, 404),
    ...Array.from({ length: 3 }, () =>
      progress([JSON.stringify({ error: 'pull model manifest: 503: unavailable' }) + '\n']),
    ),
  ];
}

test('imports an already downloaded GGUF directly with a pinned revision and no registry calls', async () => {
  const { run, requests, messages, delays } = harness(
    [
      json({}, 404),
      json({ sha: revision }),
      json([ggufFile, { ...ggufFile, path: 'mmproj-Q4_K_M.gguf' }]),
      new Response(null, { status: 200 }),
      json({ status: 'success' }),
      json({ done: true, eval_count: 1 }),
    ],
    directModel,
  );

  await run();

  assert.deepEqual(delays, []);
  assert.equal(requests[1].url, 'https://huggingface.co/api/models/unsloth/Qwen3.5-2B-GGUF');
  assert.equal(
    requests[2].url,
    `https://huggingface.co/api/models/unsloth/Qwen3.5-2B-GGUF/tree/${revision}`,
  );
  assert.equal(requests[3].method, 'HEAD');
  assert.equal(requests[3].url, `http://ollama:11434/api/blobs/${ggufDigest}`);
  assert.equal(requests[4].url, 'http://ollama:11434/api/create');
  assert.deepEqual(requests[4].body, {
    model: directModel,
    files: { [ggufFile.path]: ggufDigest },
    renderer: 'qwen3.5',
    parser: 'qwen3.5',
    stream: false,
  });
  assert.equal(requests[5].url, 'http://ollama:11434/api/generate');
  assert.equal(requests.length, 6);
  assert.ok(messages.includes('Using the cached GGUF blob; no additional download needed.'));
  assert.equal(messages.at(-1), `Model ready: ${directModel}`);
});

test('streams an absent GGUF to the blob verifier before creating and loading the model', async () => {
  const { run, requests, messages } = harness(
    [
      json({}, 404),
      json({ sha: revision }),
      json([ggufFile]),
      new Response(null, { status: 404 }),
      new Response('GGUF'),
      new Response(null, { status: 201 }),
      json({ status: 'success' }),
      json({ done: true, eval_count: 1 }),
    ],
    directModel,
  );

  await run();

  assert.equal(
    requests[4].url,
    `https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/${revision}/${ggufFile.path}`,
  );
  assert.equal(requests[5].url, `http://ollama:11434/api/blobs/${ggufDigest}`);
  assert.equal(requests[5].method, 'POST');
  assert.equal(new TextDecoder().decode(requests[5].uploaded), 'GGUF');
  assert.equal(requests[6].url, 'http://ollama:11434/api/create');
  assert.equal(requests[7].url, 'http://ollama:11434/api/generate');
  assert.equal(messages.at(-1), `Model ready: ${directModel}`);
});

for (const quantization of ['UD-IQ2_XXS', 'UD-Q4_K_XL']) {
  test(`direct import selects the exact file for hyphenated quantization ${quantization}`, async () => {
    const selectedModel = `hf.co/unsloth/Qwen3.5-0.8B-GGUF:${quantization}`;
    const filename = `Qwen3.5-0.8B-${quantization}.gguf`;
    const { run, requests } = harness(
      [
        json({}, 404),
        json({ sha: revision }),
        json([{ ...ggufFile, path: filename }]),
        new Response(null, { status: 200 }),
        json({ status: 'success' }),
        json({ done: true, eval_count: 1 }),
      ],
      selectedModel,
    );
    await run();
    assert.equal(requests[4].body.model, selectedModel);
    assert.deepEqual(requests[4].body.files, { [filename]: ggufDigest });
  });
}

for (const quantization of ['Q4_K_M', 'UD-Q4_K_XL']) {
  test(`imports the exact Gemma E2B ${quantization} GGUF with its native configuration and no projector`, async () => {
    const selectedModel = `hf.co/unsloth/gemma-4-E2B-it-GGUF:${quantization}`;
    const filename = `gemma-4-E2B-it-${quantization}.gguf`;
    const { run, requests } = harness(
      [
        json({}, 404),
        json({ sha: revision }),
        json([
          { ...ggufFile, path: filename },
          { ...ggufFile, path: `mmproj-${filename}` },
          { ...ggufFile, path: 'gemma-4-E2B-it-Q8_0.gguf' },
        ]),
        json({}),
        json({ status: 'success' }),
        json({ done: true, eval_count: 1 }),
      ],
      selectedModel,
    );
    await run();
    assert.equal(requests[1].url, 'https://huggingface.co/api/models/unsloth/gemma-4-E2B-it-GGUF');
    assert.equal(
      requests[2].url,
      `https://huggingface.co/api/models/unsloth/gemma-4-E2B-it-GGUF/tree/${revision}`,
    );
    assert.deepEqual(requests[4].body, {
      model: selectedModel,
      files: { [filename]: ggufDigest },
      renderer: 'gemma4-small',
      parser: 'gemma4',
      parameters: { stop: ['<turn|>'] },
      stream: false,
    });
    assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
    assert.ok(requests.every(({ url }) => !url.includes('mmproj') && !url.endsWith('/api/pull')));
  });
}

for (const parameters of [
  'stop                           "<turn|>"',
  'temperature                    0\r\nstop    "other"\r\nstop    "<turn|>"\r\n',
]) {
  test(`a cached Gemma E2B with native configuration and required stop starts offline: ${JSON.stringify(parameters)}`, async () => {
    const { run, requests } = harness(
      [
        json({
          modelfile: 'FROM /cache/model\nRENDERER gemma4-small\nPARSER gemma4\n',
          parameters,
        }),
        json({ done: true, eval_count: 1 }),
      ],
      gemmaModel,
    );
    await run();
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).pathname),
      ['/api/show', '/api/generate'],
    );
  });
}

for (const parameters of [
  undefined,
  'stop    "wrong"',
  'stop    "<turn|>suffix"',
  'stop    "prefix<turn|>"',
]) {
  test(`a cached Gemma with missing required stop is reimported: ${JSON.stringify(parameters)}`, async () => {
    const { run, requests } = harness(
      [
        json({ modelfile: 'RENDERER gemma4-small\nPARSER gemma4\n', parameters }),
        json({ sha: revision }),
        json([{ ...ggufFile, path: 'gemma-4-E2B-it-Q4_K_M.gguf' }]),
        json({}),
        json({ status: 'success' }),
        json({ done: true, eval_count: 1 }),
      ],
      gemmaModel,
    );
    await run();
    assert.equal(requests[4].url, 'http://ollama:11434/api/create');
    assert.deepEqual(requests[4].body.parameters, { stop: ['<turn|>'] });
    assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
  });
}

for (const [
  selectedModel,
  filename,
  previousRenderer,
  previousParser,
  expectedRenderer,
  expectedParser,
] of [
  [gemmaModel, 'gemma-4-E2B-it-Q4_K_M.gguf', 'qwen3.5', 'qwen3.5', 'gemma4-small', 'gemma4'],
  [gemmaModel, 'gemma-4-E2B-it-Q4_K_M.gguf', 'gemma4-large', 'gemma4', 'gemma4-small', 'gemma4'],
  [directModel, ggufFile.path, 'gemma4-small', 'gemma4', 'qwen3.5', 'qwen3.5'],
]) {
  test(`${selectedModel} reimports a cache with the wrong ${previousRenderer} family configuration`, async () => {
    const { run, requests } = harness(
      [
        json({ modelfile: `RENDERER ${previousRenderer}\nPARSER ${previousParser}\n` }),
        json({ sha: revision }),
        json([{ ...ggufFile, path: filename }]),
        json({}),
        json({ status: 'success' }),
        json({ done: true, eval_count: 1 }),
      ],
      selectedModel,
    );
    await run();
    assert.equal(requests[4].url, 'http://ollama:11434/api/create');
    assert.equal(requests[4].body.renderer, expectedRenderer);
    assert.equal(requests[4].body.parser, expectedParser);
    assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
  });
}

test('Gemma import fails when only the projector and another quantization exist', async () => {
  const { run, requests, delays } = harness(
    [
      json({}, 404),
      json({ sha: revision }),
      json([
        { ...ggufFile, path: 'mmproj-gemma-4-E2B-it-Q4_K_M.gguf' },
        { ...ggufFile, path: 'gemma-4-E2B-it-Q8_0.gguf' },
      ]),
    ],
    gemmaModel,
  );
  await assert.rejects(run(), /Expected exactly one GGUF file: gemma-4-E2B-it-Q4_K_M.gguf/);
  assert.equal(requests.length, 3);
  assert.deepEqual(delays, []);
});

for (const [name, responses, expected] of [
  ['invalid revision', [json({ sha: '../main' })], /Invalid Hugging Face model revision/],
  ['metadata HTTP 404', [json({}, 404)], /Reading model revision failed/],
  [
    'non-array listing',
    [json({ sha: revision }), json({ files: [] })],
    /Invalid Hugging Face file listing/,
  ],
  ['missing quantization', [json({ sha: revision }), json([])], /Expected exactly one GGUF/],
  [
    'projector only',
    [json({ sha: revision }), json([{ ...ggufFile, path: 'mmproj-Q4_K_M.gguf' }])],
    /Expected exactly one GGUF/,
  ],
  [
    'duplicate file',
    [json({ sha: revision }), json([ggufFile, ggufFile])],
    /Expected exactly one GGUF/,
  ],
  [
    'invalid SHA256',
    [json({ sha: revision }), json([{ ...ggufFile, lfs: { oid: revision, size: 4 } }])],
    /Invalid GGUF size or SHA256/,
  ],
  [
    'Git object ID without LFS digest',
    [json({ sha: revision }), json([{ ...ggufFile, lfs: null, oid: revision }])],
    /Invalid GGUF size or SHA256/,
  ],
  [
    'inconsistent size',
    [json({ sha: revision }), json([{ ...ggufFile, size: 10 }])],
    /Invalid GGUF size or SHA256/,
  ],
  [
    'blob cache permanent error',
    [json({ sha: revision }), json([ggufFile]), json({}, 403)],
    /Checking the GGUF cache failed/,
  ],
  [
    'blob digest mismatch',
    [json({ sha: revision }), json([ggufFile]), json({}, 404), new Response('GGUF'), json({}, 400)],
    /Uploading and verifying GGUF failed/,
  ],
  [
    'oversized direct download',
    [json({ sha: revision }), json([ggufFile]), json({}, 404), new Response('GGUF-extra')],
    /GGUF download exceeds its expected size/,
  ],
  [
    'create HTTP error',
    [json({ sha: revision }), json([ggufFile]), json({}), json({}, 400)],
    /Creating the local model failed/,
  ],
  [
    'create HTTP 200 error',
    [json({ sha: revision }), json([ggufFile]), json({}), json({ error: 'invalid GGUF' })],
    /Creating the local model failed/,
  ],
  [
    'unfinished create',
    [json({ sha: revision }), json([ggufFile]), json({}), json({ status: 'parsing GGUF' })],
    /local model import did not finish/,
  ],
]) {
  test(`direct GGUF ${name} prevents startup`, async () => {
    const { run, requests, messages, delays } = harness([json({}, 404), ...responses], directModel);
    await assert.rejects(run(), expected);
    assert.ok(requests.every(({ url }) => !url.endsWith('/api/generate')));
    assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
    assert.deepEqual(delays, []);
  });
}

for (const [name, failureAttempt, expected] of [
  ['revision HTTP 503', () => [json({}, 503)], /HTTP 503/],
  ['revision timeout', () => [new DOMException('timed out', 'TimeoutError')], /timed out/],
  ['tree HTTP 429', () => [json({ sha: revision }), json({}, 429)], /HTTP 429/],
  [
    'blob cache HTTP 500',
    () => [json({ sha: revision }), json([ggufFile]), json({}, 500)],
    /HTTP 500/,
  ],
  [
    'GGUF HTTP 503',
    () => [json({ sha: revision }), json([ggufFile]), json({}, 404), json({}, 503)],
    /HTTP 503/,
  ],
  [
    'truncated GGUF',
    () => [json({ sha: revision }), json([ggufFile]), json({}, 404), new Response('GG')],
    /ended before its expected size/,
  ],
  [
    'blob upload HTTP 503',
    () => [
      json({ sha: revision }),
      json([ggufFile]),
      json({}, 404),
      new Response('GGUF'),
      json({}, 503),
    ],
    /HTTP 503/,
  ],
  [
    'create HTTP 503',
    () => [json({ sha: revision }), json([ggufFile]), json({}), json({}, 503)],
    /HTTP 503/,
  ],
  [
    'create wrapped HTTP 503',
    () => [
      json({ sha: revision }),
      json([ggufFile]),
      json({}),
      json({ error: 'HTTP 503: unavailable' }),
    ],
    /503/,
  ],
]) {
  test(`direct import ${name} stops after three attempts without using the registry or loading`, async () => {
    const { run, requests, messages, delays } = harness(
      [json({}, 404), ...failureAttempt(), ...failureAttempt(), ...failureAttempt()],
      directModel,
    );
    await assert.rejects(run(), expected);
    assert.deepEqual(delays, [2000, 4000]);
    assert.equal(
      requests.filter(
        ({ url }) => url === 'https://huggingface.co/api/models/unsloth/Qwen3.5-2B-GGUF',
      ).length,
      3,
    );
    assert.ok(
      requests.every(({ url }) => !url.endsWith('/api/generate') && !url.endsWith('/api/pull')),
    );
    assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
  });
}

test('retries a truncated GGUF and loads only after a complete verified upload', async () => {
  const { run, requests, delays } = harness(
    [
      json({}, 404),
      json({ sha: revision }),
      json([ggufFile]),
      json({}, 404),
      new Response('GG'),
      json({ sha: revision }),
      json([ggufFile]),
      json({}, 404),
      new Response('GGUF'),
      json({}, 201),
      json({ status: 'success' }),
      json({ done: true, eval_count: 1 }),
    ],
    directModel,
  );
  await run();
  assert.deepEqual(delays, [2000]);
  assert.equal(
    requests.filter(({ url, method }) => url.includes('/api/blobs/') && method === 'POST').length,
    2,
  );
  assert.equal(requests.filter(({ url }) => url.endsWith('/api/create')).length, 1);
  assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
});

test('reuses the verified blob after a create timeout without downloading or uploading again', async () => {
  const { run, requests, delays } = harness(
    [
      json({}, 404),
      json({ sha: revision }),
      json([ggufFile]),
      json({}, 404),
      new Response('GGUF'),
      json({}, 201),
      new DOMException('timed out', 'TimeoutError'),
      json({ sha: revision }),
      json([ggufFile]),
      json({}),
      json({ status: 'success' }),
      json({ done: true, eval_count: 1 }),
    ],
    directModel,
  );
  await run();
  assert.deepEqual(delays, [2000]);
  assert.equal(requests.filter(({ url }) => url.includes('/resolve/')).length, 1);
  assert.equal(
    requests.filter(({ url, method }) => url.includes('/api/blobs/') && method === 'POST').length,
    1,
  );
  assert.equal(requests.filter(({ url }) => url.endsWith('/api/create')).length, 2);
  assert.equal(requests.at(-1).url, 'http://ollama:11434/api/generate');
});

test('a permanent registry error for an unrelated model fails without direct import', async () => {
  const { run, requests, delays } = harness([json({}, 404), json({}, 404)]);
  await assert.rejects(run(), /Model download failed \(HTTP 404\)/);
  assert.equal(requests.length, 2);
  assert.deepEqual(delays, []);
});

for (const unrelatedModel of [
  'hf.co/bartowski/Qwen3.5-2B-GGUF:Q4_K_M',
  'hf.co/unsloth/Qwen3-2B-GGUF:Q4_K_M',
  'qwen3.5:2b',
  'hf.co/bartowski/gemma-4-E2B-it-GGUF:Q4_K_M',
  'hf.co/unsloth/gemma-4-E4B-it-GGUF:Q4_K_M',
  'hf.co/unsloth/gemma-4-E2B-GGUF:Q4_K_M',
]) {
  test(`does not use direct import for unrelated model ${unrelatedModel}`, async () => {
    const { run, requests } = harness(failedRegistry(), unrelatedModel);
    await assert.rejects(run(), /503/);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ url }) => url.startsWith('http://ollama:11434/')));
  });
}

for (const [name, response, expected] of [
  [
    'HTTP failure',
    json({ error: 'not enough memory' }, 500),
    /Loading the model failed \(HTTP 500\)/,
  ],
  ['error with HTTP 200', json({ error: 'unsupported model' }), /unsupported model/],
  ['unfinished response', json({ done: false }), /did not finish loading/],
  ['load without generation', json({ done: true }), /did not generate a token/],
  ['zero generated tokens', json({ done: true, eval_count: 0 }), /did not generate a token/],
  ['negative token count', json({ done: true, eval_count: -1 }), /did not generate a token/],
  ['fractional token count', json({ done: true, eval_count: 0.5 }), /did not generate a token/],
  ['string token count', json({ done: true, eval_count: '1' }), /did not generate a token/],
  ['timeout', new DOMException('Startup deadline exceeded', 'TimeoutError'), /deadline exceeded/],
]) {
  test(`model load ${name} prevents startup`, async () => {
    const { run, messages } = harness([json({ details: {} }), response]);
    await assert.rejects(run(), expected);
    assert.ok(messages.every((message) => !message.startsWith('Model ready:')));
  });
}
