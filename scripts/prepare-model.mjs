import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const defaultModel = 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0';

// Exercise a normal prefill batch (roughly 750 tokens) and one decoding step before readiness.
// Empty prompts only load weights: the first GPU request can still spend tens of seconds
// preparing kernels. CPU startup also pays this bounded warmup cost instead of the first search.
const readinessPrompt =
  'This is a synthetic startup readiness check. Continue with one word after the passage.\n' +
  'The calm river flows past the green field. The blue sky stays clear.\n'.repeat(48) +
  '\nReady:';

const directGgufFamilies = [
  { name: /^Qwen3\.5-\d+(?:\.\d+)?B$/i, renderer: 'qwen3.5', parser: 'qwen3.5' },
  {
    name: /^gemma-4-E2B-it$/i,
    renderer: 'gemma4-small',
    parser: 'gemma4',
    parameters: { stop: ['<turn|>'] },
  },
];

class DownloadError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

function isTransientHttpStatus(status) {
  return [408, 425, 429].includes(status) || (status >= 500 && status < 600);
}

function isTransientDownloadError(error) {
  if (error instanceof DownloadError) return error.retryable;
  if (!(error instanceof Error) || error instanceof SyntaxError) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const details = `${error.message} ${error.cause?.code ?? ''}`;
  // Ollama can wrap the registry HTTP status in an error inside an HTTP 200 progress stream.
  const wrappedStatus = details.match(
    /(?:\bHTTP(?:\s+(?:status|code))?|\bstatus(?:\s+code)?|:)\s*[:=]?\s*([45]\d{2})(?=[:\s]|$)/i,
  );
  if (wrappedStatus) return isTransientHttpStatus(Number(wrappedStatus[1]));
  return /context deadline exceeded|timed?\s*out|fetch failed|socket|network|connection (?:reset|refused|closed|lost)|temporar|unexpected eof|premature close|terminated|ECONN|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(
    details,
  );
}

async function requireResponse(response, operation, download = false) {
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    const message = `${operation} failed (HTTP ${response.status}): ${details}`;
    if (download) {
      throw new DownloadError(message, isTransientHttpStatus(response.status));
    }
    throw new Error(message);
  }
  return response;
}

async function readPullProgress(response, log) {
  if (!response.body) throw new Error('Model download returned no progress stream.');

  let pending = '';
  let succeeded = false;
  let previousProgress = '';
  const decoder = new TextDecoder();

  function readLine(line) {
    if (!line.trim()) return;
    const update = JSON.parse(line);
    if (update.error) throw new Error(`Model download failed: ${update.error}`);
    if (typeof update.status !== 'string') throw new Error('Invalid model download progress.');
    succeeded = update.status === 'success';

    const percent =
      typeof update.total === 'number' && update.total > 0
        ? ` ${Math.floor(((update.completed ?? 0) / update.total) * 100)}%`
        : '';
    const progress = `${update.status}${percent}`;
    if (progress !== previousProgress) {
      log(progress);
      previousProgress = progress;
    }
  }

  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      readLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 1024 * 1024) throw new Error('Invalid model download progress.');
  }
  pending += decoder.decode();
  readLine(pending);
  if (!succeeded) throw new DownloadError('Model download ended before success.', true);
}

function directGgufSource(model) {
  const match = model.match(
    /^(?:hf\.co|huggingface\.co)\/(unsloth\/([^/:]+)-GGUF):([a-z0-9][a-z0-9_-]*)$/i,
  );
  if (!match) return null;
  const family = directGgufFamilies.find(({ name }) => name.test(match[2]));
  return family
    ? {
        repository: match[1],
        filename: `${match[2]}-${match[3]}.gguf`,
        renderer: family.renderer,
        parser: family.parser,
        parameters: family.parameters,
      }
    : null;
}

function hasNativeConfiguration(details, source) {
  if (typeof details?.modelfile !== 'string') return false;
  const configuration = new Map(
    [...details.modelfile.matchAll(/^(RENDERER|PARSER)[ \t]+(\S+)[ \t]*\r?$/gm)].map(
      ([, key, value]) => [key, value],
    ),
  );
  // Ollama /api/show formats stop entries as padded lines: stop    "<turn|>".
  const parameters = typeof details.parameters === 'string' ? details.parameters : '';
  const stops = [...parameters.matchAll(/^stop[ \t]+(.+?)[ \t]*\r?$/gm)].map(([, value]) => value);
  return (
    configuration.get('RENDERER') === source.renderer &&
    configuration.get('PARSER') === source.parser &&
    (source.parameters?.stop ?? []).every((value) => stops.includes(JSON.stringify(value)))
  );
}

async function importDirectGguf({ model, source, baseUrl, fetchImpl, post, log }) {
  const repositoryUrl = `https://huggingface.co/api/models/${source.repository}`;
  const infoResponse = await requireResponse(
    await fetchImpl(repositoryUrl, { signal: AbortSignal.timeout(30_000) }),
    'Reading model revision',
    true,
  );
  const info = await infoResponse.json();
  if (typeof info?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(info.sha)) {
    throw new Error('Invalid Hugging Face model revision.');
  }
  const revision = info.sha;
  const treeResponse = await requireResponse(
    await fetchImpl(`${repositoryUrl}/tree/${revision}`, {
      signal: AbortSignal.timeout(30_000),
    }),
    'Reading GGUF file metadata',
    true,
  );
  if (treeResponse.headers.get('link')?.includes('rel="next"')) {
    throw new Error('Direct GGUF import does not support paginated file listings.');
  }
  const tree = await treeResponse.json();
  if (!Array.isArray(tree)) throw new Error('Invalid Hugging Face file listing.');
  const files = tree.filter(
    (entry) =>
      entry?.type === 'file' &&
      typeof entry.path === 'string' &&
      entry.path.toLowerCase() === source.filename.toLowerCase(),
  );
  if (files.length !== 1) throw new Error(`Expected exactly one GGUF file: ${source.filename}`);
  const file = files[0];
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.lfs?.size !== file.size ||
    typeof file.lfs?.oid !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(file.lfs.oid)
  ) {
    throw new Error('Invalid GGUF size or SHA256 metadata.');
  }
  const digest = `sha256:${file.lfs.oid.toLowerCase()}`;
  const blobUrl = `${baseUrl}/api/blobs/${digest}`;
  const cached = await fetchImpl(blobUrl, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
  if (cached.status === 404) {
    log(`Downloading ${file.path} directly from Hugging Face (${file.size} bytes)...`);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
    let streamError;
    try {
      const download = await requireResponse(
        await fetchImpl(
          `https://huggingface.co/${source.repository}/resolve/${revision}/${encodeURIComponent(file.path)}`,
          { signal },
        ),
        'Downloading GGUF',
        true,
      );
      if (!download.body) throw new Error('GGUF download returned no body.');
      let received = 0;
      let previousPercent = -1;
      const body = download.body.pipeThrough(
        new TransformStream({
          transform(chunk, stream) {
            received += chunk.byteLength;
            if (received > file.size) {
              streamError = new DownloadError('GGUF download exceeds its expected size.', false);
              throw streamError;
            }
            const percent = Math.floor((received / file.size) * 100);
            if (percent !== previousPercent) {
              log(`Downloading GGUF ${percent}%`);
              previousPercent = percent;
            }
            stream.enqueue(chunk);
          },
          flush() {
            if (received !== file.size) {
              streamError = new DownloadError(
                'GGUF download ended before its expected size.',
                true,
              );
              throw streamError;
            }
          },
        }),
      );
      await requireResponse(
        await fetchImpl(blobUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(file.size),
          },
          body,
          duplex: 'half',
          signal,
        }),
        'Uploading and verifying GGUF',
        true,
      );
    } catch (error) {
      // Native fetch wraps body errors in TypeError; keep size validation's retry policy.
      throw streamError ?? error;
    } finally {
      controller.abort();
    }
  } else {
    await requireResponse(cached, 'Checking the GGUF cache', true);
    log('Using the cached GGUF blob; no additional download needed.');
  }

  log('Creating the local model from the verified GGUF...');
  const created = await requireResponse(
    await post(
      '/api/create',
      {
        model,
        files: { [file.path]: digest },
        renderer: source.renderer,
        parser: source.parser,
        ...(source.parameters ? { parameters: source.parameters } : {}),
        stream: false,
      },
      5 * 60_000,
    ),
    'Creating the local model',
    true,
  );
  const result = await created.json();
  if (result?.error) throw new Error(`Creating the local model failed: ${result.error}`);
  if (result?.status !== 'success') throw new Error('The local model import did not finish.');
}

export async function prepareModel({
  url = process.env.OLLAMA_URL ?? 'http://ollama:11434',
  model = process.env.OLLAMA_MODEL ?? defaultModel,
  fetchImpl = fetch,
  log = console.info,
  delayImpl = delay,
  onStatus,
  signal,
} = {}) {
  signal?.throwIfAborted();
  if (!model.trim()) throw new Error('OLLAMA_MODEL must not be empty.');
  const baseUrl = url.replace(/\/+$/, '');

  const request = (requestUrl, options) => {
    signal?.throwIfAborted();
    return fetchImpl(requestUrl, {
      ...options,
      signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal,
    });
  };

  async function post(path, body, timeoutMs) {
    return request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function downloadWithRetry(operation) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      log(`Model download attempt ${attempt}/3`);
      try {
        await operation();
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (!isTransientDownloadError(error) || attempt === 3) throw error;
        const retryDelayMs = 2000 * attempt;
        log(`Temporary download failure: ${error.message}. Retrying in ${retryDelayMs / 1000}s...`);
        await delayImpl(retryDelayMs, undefined, { signal });
      }
    }
  }

  const source = directGgufSource(model);
  log(`Checking local model: ${model}`);
  const existing = await post('/api/show', { model }, 30_000);
  let cached = false;
  if (existing.status !== 404) {
    await requireResponse(existing, 'Checking the model cache');
    const details = await existing.json();
    if (details.error) throw new Error(`Checking the model cache failed: ${details.error}`);
    cached = !source || hasNativeConfiguration(details, source);
    if (!cached)
      log(`Updating the cached model to the required native configuration (${source.renderer})...`);
  }

  if (cached) {
    log('Using the cached model; no download needed.');
  } else {
    onStatus?.('downloading');
    log('Downloading the model. The first start needs an internet connection.');
    await downloadWithRetry(async () => {
      if (source) {
        await importDirectGguf({ model, source, baseUrl, fetchImpl: request, post, log });
      } else {
        const download = await requireResponse(
          await post('/api/pull', { model, stream: true }, 30 * 60_000),
          'Model download',
          true,
        );
        await readPullProgress(download, log);
      }
    });
  }

  onStatus?.('warming');
  log('Loading the model and warming up prompt evaluation...');
  const loaded = await requireResponse(
    await post(
      '/api/generate',
      {
        model,
        prompt: readinessPrompt,
        raw: true,
        think: false,
        stream: false,
        keep_alive: -1,
        options: { num_ctx: 4096, num_predict: 1, temperature: 0 },
      },
      5 * 60_000,
    ),
    'Loading the model',
  );
  const result = await loaded.json();
  if (result.error) throw new Error(`Loading the model failed: ${result.error}`);
  if (result.done !== true) throw new Error('The model did not finish loading.');
  if (!Number.isInteger(result.eval_count) || result.eval_count <= 0) {
    throw new Error('The model did not generate a token during warmup.');
  }
  log(`Model ready: ${model}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareModel().catch((error) => {
    console.error(`AI startup failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
