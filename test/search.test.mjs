import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchClient } from '../src/research/search.mjs';
import { fetchSource } from '../src/research/fetch-source.mjs';

const html = `<!doctype html><html><head><title>Evidence page</title><meta name="description" content="A concise description"></head><body><article><h1>Evidence page</h1><p>Independent data reports measurable progress, but manufacturing costs remain uncertain.</p></article></body></html>`;

test('search client uses the public fallback and normalizes result links', async () => {
  const searchHtml = `<a class="result__a" href="https://example.com/evidence?utm_source=ddg">Evidence result</a>`;
  const client = new SearchClient({ env: { SEARCH_PROVIDER: 'brave' }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => searchHtml }) });
  const result = await client.search('evidence question', { limit: 2, role: 'SKEPTIC' });
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.role, 'SKEPTIC');
  assert.equal(result.results[0].url, 'https://example.com/evidence?utm_source=ddg');
  assert.ok(result.errors.some((error) => error.includes('BRAVE_SEARCH_API_KEY')));
});

test('source fetch extracts bounded metadata and records role/provenance', async () => {
  const source = await fetchSource('https://example.com/evidence', { role: 'FOLLOW_UP', searchResult: { title: 'Search title', snippet: 'Search excerpt' }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
  assert.equal(source.title, 'Evidence page');
  assert.equal(source.publisher, 'example.com');
  assert.equal(source.searchRole, 'FOLLOW_UP');
  assert.match(source.excerpt, /Search excerpt/);
  assert.equal(source.fetchError, undefined);
});
