import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, deduplicateSources, textFingerprint, tokenSetSimilarity, scoreSourceQuality, inferSourceRole } from '../src/domain/normalization.mjs';
import { EvidenceType, AdjudicationStatus, SourceRelationshipType, createClaim, createSource } from '../src/domain/models.mjs';
import { deriveSourceRelationships, findSourceLineages, calculateIndependentGroups, adjudicateClaims, detectWeakClaims, generateFollowUpTaskSpecs, buildGraphPayload, buildCitationSafeReport } from '../src/domain/graph.mjs';

const ids = { session: '00000000-0000-4000-8000-000000000001', claim: '00000000-0000-4000-8000-000000000002', a: '00000000-0000-4000-8000-000000000003', b: '00000000-0000-4000-8000-000000000004', c: '00000000-0000-4000-8000-000000000005' };
const source = (id, url, extra = {}) => ({ ...createSource({ id, url, title: extra.title ?? `Synthetic source ${id.slice(-1)}`, publisher: 'Synthetic Fixture', sourceType: extra.sourceType ?? 'official', ...extra }), ...(extra.content ? { content: extra.content } : {}) });
const claim = (id = ids.claim, text = 'Synthetic claim used only by a deterministic unit test.') => createClaim({ id, sessionId: ids.session, text });
const edge = (sourceId, type, confidence = 90, claimId = ids.claim) => ({ id: `${sourceId.slice(-1)}0000000-0000-4000-8000-000000000000`, claimId, sourceId, type, confidence, quote: 'Synthetic quote.' });

test('canonicalizes URLs and deduplicates tracking variants', () => {
  assert.equal(canonicalizeUrl('HTTPS://Example.COM:443/a//b/?utm_source=x&b=2&a=1#part'), 'https://example.com/a/b?a=1&b=2');
  const sources = [source(ids.a, 'https://example.com/report?utm_medium=x'), source(ids.b, 'https://EXAMPLE.com/report#citation')];
  assert.equal(deduplicateSources(sources).length, 1);
});

test('normalization fingerprints and compares text stably', () => {
  assert.equal(textFingerprint(' A  B '), textFingerprint('a b'));
  assert.equal(tokenSetSimilarity('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.ok(scoreSourceQuality({ sourceType: 'official', publisher: 'Synthetic', title: 'Record', url: 'https://example.test' }) > scoreSourceQuality({ sourceType: 'blog', publisher: 'Unknown publisher' }));
  assert.equal(inferSourceRole({ sourceType: 'official' }), 'PRIMARY');
});

test('model constructors bound values and reject chain-of-thought fields', () => {
  assert.throws(() => createClaim({ sessionId: ids.session, text: 'x', chainOfThought: 'not stored' }), /not permitted/);
  assert.throws(() => createSource({ id: 'not-a-uuid', url: 'https://example.test' }), /UUID/);
});

test('derives explicit and possible genealogy without network access', () => {
  const a = source(ids.a, 'https://a.example/report', { content: 'one two three four five six seven eight nine ten eleven twelve' });
  const b = source(ids.b, 'https://b.example/report', { content: a.content });
  const c = source(ids.c, 'https://c.example/report');
  const links = deriveSourceRelationships([a, b, c], [{ sourceId: ids.a, targetSourceId: ids.c, type: SourceRelationshipType.CITES, confidence: 99 }, { sourceId: ids.b, targetSourceId: ids.a, type: SourceRelationshipType.DERIVED_FROM, confidence: 72, suspected: true, basis: 'explicit hyperlink' }]);
  assert.ok(links.some(link => link.type === SourceRelationshipType.CITES));
  assert.ok(links.some(link => link.type === SourceRelationshipType.DERIVED_FROM && link.suspected));
  assert.ok(links.some(link => link.type === SourceRelationshipType.POSSIBLY_SAME_ORIGIN));
  assert.equal(findSourceLineages([a, b, c], links).length, 1);
});

test('collapses correlated sources when counting independent evidence', () => {
  const a = source(ids.a, 'https://a.example'); const b = source(ids.b, 'https://b.example'); const c = source(ids.c, 'https://c.example');
  const groups = calculateIndependentGroups([edge(ids.a, EvidenceType.SUPPORTS), edge(ids.b, EvidenceType.SUPPORTS), edge(ids.c, EvidenceType.CONTRADICTS)], [a, b, c], [{ sourceId: ids.a, targetSourceId: ids.b, type: SourceRelationshipType.DERIVED_FROM, confidence: 95 }]);
  assert.equal(groups[0].support.length, 1);
  assert.equal(groups[0].contradiction.length, 1);
});

test('adjudicates supported, contradicted, mixed and uncertain claims', () => {
  const sources = [source(ids.a, 'https://a.example'), source(ids.b, 'https://b.example'), source(ids.c, 'https://c.example')];
  const statuses = [
    adjudicateClaims([claim()], [edge(ids.a, EvidenceType.SUPPORTS, 95)], sources)[0].status,
    adjudicateClaims([claim()], [edge(ids.a, EvidenceType.CONTRADICTS, 95)], sources)[0].status,
    adjudicateClaims([claim()], [edge(ids.a, EvidenceType.SUPPORTS, 95), edge(ids.b, EvidenceType.CONTRADICTS, 95)], sources)[0].status,
    adjudicateClaims([claim()], [edge(ids.a, EvidenceType.SUPPORTS, 10)], sources)[0].status
  ];
  assert.deepEqual(statuses, [AdjudicationStatus.SUPPORTED, AdjudicationStatus.CONTRADICTED, AdjudicationStatus.MIXED, AdjudicationStatus.UNCERTAIN]);
});

test('detects weak claims and creates bounded targeted follow-up specs', () => {
  const weak = detectWeakClaims([claim()], [{ claimId: ids.claim, status: AdjudicationStatus.UNCERTAIN, evidenceStrength: 10 }]);
  const tasks = generateFollowUpTaskSpecs(weak, { maxTasks: 1, sessionId: ids.session });
  assert.equal(weak.length, 1); assert.equal(tasks.length, 1); assert.match(tasks[0].objective, /independent source/);
});

test('builds graph payload and citation-safe report from supplied entities', () => {
  const c = claim(); const s = source(ids.a, 'https://a.example/report'); const e = edge(ids.a, EvidenceType.SUPPORTS);
  const adjudication = adjudicateClaims([c], [e], [s])[0];
  const graph = buildGraphPayload({ claims: [c], sources: [s], evidenceEdges: [e], adjudications: [adjudication] });
  assert.equal(graph.nodes.length, 3); assert.equal(graph.edges.length, 1);
  const report = buildCitationSafeReport({ claims: [c], sources: [s], evidenceEdges: [e], adjudications: [adjudication] });
  assert.equal(report.claims[0].evidence[0].citation.url, s.url);
});
