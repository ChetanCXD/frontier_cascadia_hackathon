import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonSessionStore } from '../src/domain/store.mjs';
import { ResearchPipeline } from '../src/research/pipeline.mjs';
import { SearchClient } from '../src/research/search.mjs';

class ThrowingSearch {
  async search(query) { return { query, provider: 'fixture', errors: [], results: [{ title: 'Unavailable source', url: 'https://unavailable.example/source', snippet: 'A result was found but its page is unavailable.' }] }; }
}
class FatalSearch { async search() { throw new Error('simulated search service failure'); } }

test('provider failure is reported without crashing the search adapter', async () => {
  const client = new SearchClient({ env: { SEARCH_PROVIDER: 'duckduckgo' }, fetchImpl: async () => { throw new Error('simulated network timeout'); } });
  const result = await client.search('failure test');
  assert.deepEqual(result.results, []);
  assert.ok(result.errors.some((error) => error.includes('simulated network timeout')));
});

test('a fatal research error is persisted as FAILED with a visible event', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-fatal-'));
  try {
    const store = await new JsonSessionStore(root).init(); const created = await store.create('Can a fatal search error be represented?');
    const pipeline = new ResearchPipeline({ store, searchClient: new FatalSearch(), config: { maxSearchCalls: 2, maxSources: 2, maxClaims: 2, maxFollowUps: 0, maxIterations: 1 } });
    await pipeline.run(created.session.id); const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'FAILED'); assert.match(state.session.error, /simulated search service failure/); assert.ok(state.errors.length); assert.ok(state.events.some((event) => event.type === 'session.failed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed source fetch preserves a complete partial session', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-failure-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const created = await store.create('Can a failed source be handled gracefully?');
    const pipeline = new ResearchPipeline({
      store, searchClient: new ThrowingSearch(),
      fetchSourceImpl: async () => { throw new Error('simulated page timeout'); },
      config: { maxSearchCalls: 5, maxSources: 5, maxClaims: 3, maxFollowUps: 0, maxIterations: 1, searchResultsPerCall: 1 },
    });
    await pipeline.run(created.session.id);
    const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'COMPLETE');
    assert.ok(state.events.some((event) => event.type === 'research.source.failed'));
    assert.ok(state.report);
    assert.ok(state.report.limitations.some((item) => /No source was retrieved|retrieved source/i.test(item)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
