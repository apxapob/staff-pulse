import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SEARCH_COMPARISON_DESCRIPTION, searchResultsEqual } from './search-comparison.mjs';

const fixtureUrl = new URL('./fixtures/search-evaluation.json', import.meta.url);
const usage = `Evaluate a running model-backed Staff Pulse API with independent Russian queries.

Usage: node scripts/evaluate-search.mjs [options]
  --base-url URL       Application origin (default: http://localhost:8080)
  --timeout-ms N       Deadline for each request, 1..120000 (default: 60000)
  --fixture PATH       Read another evaluation fixture (default: bundled corpus)
  --limit N            Run only the first N selected cases
  --case ID            Select a case by ID; repeat to select several
  --output PATH        Write the complete JSON report
  --help               Show this help

Requests are sequential. Recognized queries must return source:ai and the complete
expected filter. Unsupported queries must retain the entire query as source:text.
Fixtures must use version 2 (groups/sort/limit). OR group and AND condition order
do not affect comparison; AI name conditions are case-insensitive. Identical AND
duplicates are ignored; same-field gte N AND lte N is equivalent to eq N.
The first request includes any model cold start. Exit code 1 means a failed case;
exit code 2 means invalid arguments or an evaluation setup error.`;

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return number;
}

function summary(results) {
  const times = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const passed = results.filter((result) => result.passed).length;
  const byGroup = Object.create(null);
  const bySource = Object.create(null);
  for (const result of results) {
    byGroup[result.group] ??= { passed: 0, total: 0 };
    byGroup[result.group].total += 1;
    byGroup[result.group].passed += Number(result.passed);
    const source = result.actual?.source ?? 'error';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    exactSemanticAccuracy: passed / results.length,
    byGroup,
    bySource,
    latencyMs: {
      min: times[0],
      median: Math.round(
        (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
      ),
      p95: times[Math.ceil(times.length * 0.95) - 1],
      max: times.at(-1),
      mean: Math.round(times.reduce((sum, time) => sum + time, 0) / times.length),
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://localhost:8080' },
      'timeout-ms': { type: 'string', default: '60000' },
      fixture: { type: 'string' },
      limit: { type: 'string' },
      case: { type: 'string', multiple: true },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const base = new URL(values['base-url']);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error(
      '--base-url must be an HTTP(S) origin without credentials, path, query or hash.',
    );
  }
  const endpoint = new URL('/api/search', base).href;
  const timeoutMs = positiveInteger(values['timeout-ms'], '--timeout-ms', 120_000);
  const fixturePath =
    values.fixture === undefined ? fileURLToPath(fixtureUrl) : resolve(values.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (fixture.version !== 2 || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error('Expected a version 2 evaluation fixture with a nonempty cases array.');
  }
  const requested = new Set(values.case ?? []);
  const known = new Set(fixture.cases.map((item) => item.id));
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`Unknown case: ${id}.`);
  }
  let cases = fixture.cases.filter((item) => requested.size === 0 || requested.has(item.id));
  if (values.limit !== undefined) cases = cases.slice(0, positiveInteger(values.limit, '--limit'));
  if (!cases.length) throw new Error('No evaluation cases selected.');

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];
  console.log(
    `Evaluating ${cases.length} cases at ${endpoint}; per-request deadline ${timeoutMs} ms.`,
  );
  for (const item of cases) {
    const requestStarted = performance.now();
    const result = { ...item, passed: false };
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: item.query }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      result.httpStatus = response.status;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      result.actual = { source: body?.source, filter: body?.filter };
      result.passed = searchResultsEqual(result.actual, item.expected);
      if (!result.passed)
        result.error = 'Source or complete filter differs from expected semantics.';
    } catch (error) {
      result.error =
        error?.name === 'TimeoutError' ? `Request exceeded ${timeoutMs} ms.` : error.message;
    }
    result.durationMs = Math.round(performance.now() - requestStarted);
    results.push(result);
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${item.id} (${result.durationMs} ms): ${item.query}`,
    );
    if (!result.passed) {
      console.log(`  Expected: ${JSON.stringify(item.expected)}`);
      if (result.actual) console.log(`  Actual:   ${JSON.stringify(result.actual)}`);
      console.log(`  ${result.error}`);
    }
  }
  const report = {
    fixtureVersion: fixture.version,
    fixturePath,
    startedAt,
    endpoint,
    timeoutMs,
    durationMs: Math.round(performance.now() - started),
    comparison: SEARCH_COMPARISON_DESCRIPTION,
    summary: summary(results),
    results,
  };
  const { passed, total, exactSemanticAccuracy, latencyMs } = report.summary;
  console.log(
    `\nExact semantic accuracy: ${passed}/${total} (${(exactSemanticAccuracy * 100).toFixed(1)}%).`,
  );
  console.log(
    `Latency: median ${latencyMs.median} ms; p95 ${latencyMs.p95} ms; mean ${latencyMs.mean} ms.`,
  );
  console.log(`Sources: ${JSON.stringify(report.summary.bySource)}`);
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Report written to ${values.output}.`);
  }
  if (passed !== total) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Evaluation could not run: ${error.message}`);
  process.exitCode = 2;
});
