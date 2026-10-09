import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { sourceFetch, sourceAttempt } = await vite.ssrLoadModule('/lib/source-health.ts');

test('source HTTP failures release response streams before retry; success remains readable', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const events = [];
  let attempts = 0;
  globalThis.fetch = async () => {
    events.push('fetch');
    if (attempts++ === 0) return new Response(new ReadableStream({ cancel() { events.push('cancel'); } }), { status: 503 });
    return new Response('{"observation":3.1}');
  };
  const response = await sourceFetch('https://provider.example/data');
  assert.deepEqual(events, ['fetch', 'cancel', 'fetch']);
  assert.deepEqual(await response.json(), { observation: 3.1 });
});

test('permanent failures and exhausted retries close every stream without leaking provider bodies', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const status of [403, 429, 500]) {
    let calls = 0, cancelled = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status });
    };
    const checks = [];
    assert.equal(await sourceAttempt(checks, 'Official provider', 'https://provider.example/data', 'ALL', ['rate'], () => sourceFetch('https://provider.example/data')), null);
    assert.equal(calls, status === 500 ? 2 : 1);
    assert.equal(cancelled, calls);
    assert.equal(checks[0].cause, `HTTP_${status}`);
    assert.equal(checks[0].status, 'FAILED');
  }
});
