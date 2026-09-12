import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClaimLensServer } from '../src/server.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SearchFixture {
  async search(query, { role }) {
    return { query, provider: 'fixture', errors: [], results: [{
      title: role === 'RESEARCHER' ? 'Primary report on the research question' : 'Skeptic analysis finds a limitation',
      url: `https://${role === 'RESEARCHER' ? 'primary' : 'skeptic'}.example/evidence`,
      snippet: role === 'RESEARCHER' ? 'A primary report finds measurable progress in the target area.' : 'However, independent analysis finds limitations and uncertainty in the target area.',
    }] };
  }
}
const fetchFixture = async (url, { searchResult, role }) => ({ url, canonicalUrl: url, title: searchResult.title, publisher: new URL(url).hostname, sourceType: role === 'RESEARCHER' ? 'government' : 'analysis', quality: role === 'RESEARCHER' ? 90 : 65, excerpt: searchResult.snippet, content: `${searchResult.snippet} This fixture preserves a source excerpt for testing.`, links: [], retrievedAt: new Date().toISOString() });

test('HTTP API creates, persists, polls and serves a complete research session', async () => {
  const dataDir = await mkdtemp(join('/tmp', 'claimlens-server-'));
  const { server, store } = await createClaimLensServer({ dataDir, searchClient: new SearchFixture(), fetchSourceImpl: fetchFixture, pipelineConfig: { maxSearchCalls: 7, maxSources: 12, maxClaims: 4, maxFollowUps: 1 } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    for (const body of [{}, { question: 42 }, { question: 'short' }, null, []]) {
      const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400); assert.ok((await response.json()).error);
    }
    const malformed = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' });
    assert.equal(malformed.status, 400);
    const createdResponse = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Can this evidence workflow be tested reliably?' }) });
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
    let snapshot;
    for (let attempt = 0; attempt < 40; attempt++) {
      snapshot = await (await fetch(`${base}/api/sessions/${created.sessionId}`)).json();
      if (snapshot.session.status === 'COMPLETE' || snapshot.session.status === 'PAUSED') break;
      await wait(25);
    }
    assert.equal(snapshot.session.status, 'COMPLETE');
    assert.ok(snapshot.sources.length >= 2);
    assert.ok(snapshot.claims.length >= 1);
    assert.ok(snapshot.evidenceEdges.length >= 1);
    assert.ok(snapshot.events.some((event) => event.type === 'skeptic.completed'));
    assert.ok(snapshot.report.claims.every((claim) => claim.evidence.every((item) => item.citation.sourceId)));
    assert.ok(snapshot.graph.nodes.some((node) => node.type === 'claim'));
    const events = await (await fetch(`${base}/api/sessions/${created.sessionId}/events?after=-1`)).json();
    assert.ok(events.events.length >= snapshot.events.length);
    const badCursor = await fetch(`${base}/api/sessions/${created.sessionId}/events?after=not-a-cursor`);
    assert.equal(badCursor.status, 400);
    assert.ok((await store.load(created.sessionId)).report);
    assert.equal((await (await fetch(`${base}/styles.css`)).text()).includes('--mint'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
