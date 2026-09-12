import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonSessionStore } from '../src/domain/store.mjs';
import { ResearchPipeline } from '../src/research/pipeline.mjs';

class FixtureSearch {
  constructor() { this.calls = []; }
  async search(query, { role }) {
    this.calls.push({ query, role });
    const skeptic = role !== 'RESEARCHER';
    return {
      query, provider: 'fixture', errors: [],
      results: [{
        title: skeptic ? 'Independent analysis: manufacturing delays remain a concern' : 'Research report: battery pilots show progress',
        url: skeptic ? 'https://independent.example/analysis' : 'https://primary.example/report',
        snippet: skeptic ? 'Independent analysis finds manufacturing delays and cost challenges may limit mass-market adoption.' : 'A research report describes progress in pilot production and improved energy density.',
      }],
    };
  }
}

const fixtureFetch = async (url, { searchResult, role }) => ({
  url,
  canonicalUrl: url,
  title: searchResult.title,
  publisher: new URL(url).hostname,
  sourceType: role === 'RESEARCHER' ? 'academic' : 'analysis',
  sourceKind: role === 'RESEARCHER' ? 'PRIMARY' : 'SECONDARY',
  quality: role === 'RESEARCHER' ? 85 : 68,
  excerpt: searchResult.snippet,
  content: `${searchResult.snippet} This source was retrieved by the ${role.toLowerCase()} role.`,
  links: [],
  retrievedAt: new Date().toISOString(),
});

test('pipeline runs distinct researcher and skeptic stages and persists a report', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-pipeline-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const created = await store.create('Will solid-state batteries reach mass-market electric vehicles before 2030?');
    const search = new FixtureSearch();
    const pipeline = new ResearchPipeline({ store, searchClient: search, fetchSourceImpl: fixtureFetch, config: { maxSearchCalls: 8, maxSources: 10, maxClaims: 4, maxFollowUps: 1, maxIterations: 2, searchResultsPerCall: 2 } });
    await pipeline.run(created.session.id);
    const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'COMPLETE');
    assert.ok(state.sources.length >= 2);
    assert.ok(search.calls.some((call) => call.role === 'RESEARCHER'));
    assert.ok(search.calls.some((call) => call.role === 'SKEPTIC'));
    assert.ok(state.events.some((event) => event.type === 'skeptic.completed'));
    assert.ok(state.claims.length > 0);
    assert.ok(state.evidenceEdges.length > 0);
    assert.ok(state.report?.claims.every((claim) => claim.evidence.every((item) => item.citation.sourceId)));
    assert.ok(state.graph.nodes.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class WeakSearch {
  constructor() { this.calls = []; }
  async search(query, { role }) {
    this.calls.push({ query, role });
    if (role !== 'FOLLOW_UP') return { query, provider: 'fixture', errors: [], results: [] };
    return { query, provider: 'fixture', errors: [], results: [{ title: 'Independent follow-up finds limited evidence', url: 'https://follow-up.example/report', snippet: 'The targeted follow-up finds no evidence that the proposition is established and reports substantial uncertainty.' }] };
  }
}

test('weak evidence triggers an actual bounded follow-up search', async () => {
  const root = await mkdtemp(join('/tmp', 'claimlens-followup-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const created = await store.create('Is the evidence sufficient for this narrow question?');
    const search = new WeakSearch();
    const pipeline = new ResearchPipeline({ store, searchClient: search, fetchSourceImpl: fixtureFetch, config: { maxSearchCalls: 8, maxSources: 5, maxClaims: 3, maxFollowUps: 1, maxIterations: 2, searchResultsPerCall: 1 } });
    await pipeline.run(created.session.id);
    const state = await store.load(created.session.id);
    assert.equal(state.session.status, 'COMPLETE');
    assert.ok(search.calls.some((call) => call.role === 'FOLLOW_UP'));
    assert.ok(state.events.some((event) => event.type === 'followup.triggered'));
    assert.ok(state.tasks.some((task) => task.assignedTo === 'FOLLOW_UP'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
