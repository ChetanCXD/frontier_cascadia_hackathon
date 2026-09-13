import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonSessionStore } from '../src/domain/store.mjs';
import { ResearchPipeline } from '../src/research/pipeline.mjs';

const passages = {
  RESEARCHER: ['https://research.example/study', 'A controlled study reports measurable improvement after twelve weeks.'],
  SKEPTIC: ['https://research.example/review', 'An independent review reports substantial uncertainty and important limitations.'],
  FOLLOW_UP: ['https://research.example/follow-up', 'A follow-up analysis reports that the available evidence remains limited.'],
};
function packet(role, onProgress) {
  const [url, excerpt] = passages[role];
  onProgress?.({ kind: 'web_search', query: `${role} evidence`, queryCount: 1 });
  onProgress?.({ kind: 'get_search_content', query: url, queryCount: 0 });
  const claimText = 'The intervention improves outcomes.';
  const edgeType = role === 'RESEARCHER' ? 'SUPPORTS' : role === 'SKEPTIC' ? 'CONTRADICTS' : 'QUALIFIES';
  return {
    result: {
      role, queries: [`${role} evidence`],
      sources: [{ url, title: `${role} source`, publisher: 'Research Example', publishedAt: role === 'RESEARCHER' ? '2024-01-02T03:04:05Z' : undefined, excerpt, sourceType: 'web' }],
      claims: [{ text: claimText }],
      edges: [{ claimText, sourceUrl: url, type: edgeType, confidence: 65, quote: excerpt.slice(2, 55) }],
      contradictions: [], qualifications: [], followUpReasons: role === 'SKEPTIC' ? ['The evidence has limitations.'] : [],
      assessments: [{ claimText, status: role === 'RESEARCHER' ? 'SUPPORTED' : 'MIXED', evidenceStrength: 55, citations: [url] }],
      finalConclusion: 'The retrieved material is mixed and remains bounded by the cited evidence.',
    },
    provider: 'pi', runtime: 'pi', searchCalls: 1,
    observedUrls: [url], observedText: [excerpt], observedContent: { [url]: [excerpt] },
  };
}

class FakePiRunner {
  constructor() { this.config = { model: 'fixture-pi', projectDir: '/tmp/fixture-project' }; this.calls = []; }
  async run(input) { this.calls.push({ role: input.role, claims: input.claims, sources: input.sources, followUpReasons: input.followUpReasons }); return packet(input.role, input.onProgress); }
}

test('injected Pi runner executes distinct roles and persists only receipt-grounded report evidence', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-pi-pipeline-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const created = await store.create('Does the intervention improve outcomes after twelve weeks?');
    const runner = new FakePiRunner();
    const pipeline = new ResearchPipeline({ store, piRunner: runner, config: { maxSearchCalls: 4, maxSources: 8, maxClaims: 3, maxFollowUps: 1, maxIterations: 2 } });
    await pipeline.run(created.session.id);
    const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'COMPLETE');
    assert.deepEqual(runner.calls.map((call) => call.role), ['RESEARCHER', 'SKEPTIC', 'FOLLOW_UP']);
    assert.ok(runner.calls[1].claims.length >= 1);
    assert.ok(runner.calls[2].followUpReasons.length >= 1);
    assert.ok(state.events.some((event) => event.type === 'research.pi.progress' && event.payload.role === 'SKEPTIC'));
    assert.ok(state.events.some((event) => event.type === 'followup.triggered'));
    assert.ok(state.evidenceEdges.every((edge) => state.sources.some((source) => source.id === edge.sourceId)));
    assert.equal(state.sources.find((source) => source.url === passages.RESEARCHER[0]).publishedAt, '2024-01-02T03:04:05Z');
    assert.ok(state.report.keyFindings.every((finding) => finding.citations.every((citation) => citation.url.startsWith('https://research.example/'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi source budgets apply cumulatively across researcher, skeptic, and follow-up', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-pi-budget-'));
  try {
    const store = await new JsonSessionStore(root).init(); const created = await store.create('Can cumulative Pi evidence budgets be enforced?');
    const pipeline = new ResearchPipeline({ store, piRunner: new FakePiRunner(), config: { maxSearchCalls: 4, maxSources: 2, maxClaims: 3, maxFollowUps: 1, maxIterations: 2 } });
    await pipeline.run(created.session.id); const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'FAILED'); assert.match(state.session.error, /cumulative|budget/i); assert.equal(state.sources.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('injected Pi runner without receipts fails closed before persistence', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-pi-invalid-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const created = await store.create('Can this invalid evidence result be rejected safely?');
    const runner = { config: { model: 'fixture-pi' }, async run() { return packet('RESEARCHER', null).result; } };
    const pipeline = new ResearchPipeline({ store, piRunner: runner });
    await pipeline.run(created.session.id);
    const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'FAILED');
    assert.equal(state.sources.length, 0);
    assert.match(state.session.error, /receipts/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
