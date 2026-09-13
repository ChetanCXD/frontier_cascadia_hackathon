import test from 'node:test';
import assert from 'node:assert/strict';
import { PiOutputError, validatePiResult, normalizeObservedUrl } from '../src/research/pi-schema.mjs';

const sourceA = 'https://example.org/a';
const sourceB = 'https://example.org/b';
const excerptA = 'A controlled study reports improved outcomes after twelve weeks.';
const excerptB = 'The independent review reports substantial uncertainty in the result.';
function result(overrides = {}) {
  return {
    role: 'RESEARCHER', queries: ['question evidence'],
    sources: [
      { url: sourceA, title: 'Study A', publisher: 'Example', excerpt: excerptA, sourceType: 'web' },
      { url: sourceB, title: 'Review B', publisher: 'Example', excerpt: excerptB, sourceType: 'web' },
    ],
    claims: [{ text: 'The intervention improves outcomes.' }],
    edges: [{ claimText: 'The intervention improves outcomes.', sourceUrl: sourceA, type: 'SUPPORTS', confidence: 80, quote: 'improved outcomes after twelve weeks' }],
    contradictions: [], qualifications: [], followUpReasons: [],
    assessments: [{ claimText: 'The intervention improves outcomes.', status: 'SUPPORTED', evidenceStrength: 80, citations: [sourceA] }],
    finalConclusion: 'The retrieved study supports the claim, with uncertainty remaining.',
    ...overrides,
  };
}
function receipts() {
  return {
    observedUrls: new Set([normalizeObservedUrl(sourceA), normalizeObservedUrl(sourceB)]),
    observedText: [excerptA, excerptB],
    observedContent: new Map([[normalizeObservedUrl(sourceA), [excerptA]], [normalizeObservedUrl(sourceB), [excerptB]]]),
  };
}

test('Pi schema accepts source-scoped grounded receipts and rejects unknown URLs', () => {
  assert.equal(validatePiResult(result(), { role: 'RESEARCHER', ...receipts() }).claims.length, 1);
  assert.throws(() => validatePiResult(result({ sources: [{ url: 'https://unknown.example', title: 'Fake', publisher: 'Fake', excerpt: excerptA, sourceType: 'web' }, { url: sourceB, title: 'Review B', publisher: 'Example', excerpt: excerptB, sourceType: 'web' }] }), { role: 'RESEARCHER', ...receipts() }), PiOutputError);
});

test('Pi schema does not allow a quote from one source to be attached to another', () => {
  const invalid = result({
    edges: [{ claimText: 'The intervention improves outcomes.', sourceUrl: sourceB, type: 'SUPPORTS', confidence: 80, quote: 'improved outcomes after twelve weeks' }],
  });
  assert.throws(() => validatePiResult(invalid, { role: 'RESEARCHER', ...receipts() }), /not grounded/);
});

test('Pi schema rejects private IPv4 and IPv6 source URLs', () => {
  for (const privateUrl of ['http://127.0.0.1/a', 'http://[::1]/a', 'http://[fd00::1]/a', 'http://[fe80::1]/a', 'http://[::ffff:7f00:1]/a']) {
    const invalid = result({ sources: [{ url: privateUrl, title: 'Private', publisher: 'Local', excerpt: excerptA, sourceType: 'web' }], edges: [{ claimText: 'The intervention improves outcomes.', sourceUrl: privateUrl, type: 'SUPPORTS', confidence: 80, quote: 'improved outcomes after twelve weeks' }], assessments: [{ claimText: 'The intervention improves outcomes.', status: 'SUPPORTED', evidenceStrength: 80, citations: [privateUrl] }] });
    const privateReceipts = { observedUrls: new Set([normalizeObservedUrl(privateUrl)]), observedText: [excerptA], observedContent: new Map([[normalizeObservedUrl(privateUrl), [excerptA]]]) };
    assert.throws(() => validatePiResult(invalid, { role: 'RESEARCHER', ...privateReceipts }), PiOutputError);
  }
});

test('Pi schema requires structured notes, exact assessments, and no extra fields', () => {
  assert.throws(() => validatePiResult(result({ contradictions: ['not an object'] }), { role: 'RESEARCHER', ...receipts() }), PiOutputError);
  assert.throws(() => validatePiResult({ ...result(), unexpected: true }, { role: 'RESEARCHER', ...receipts() }), /not permitted/);
  assert.throws(() => validatePiResult(result({ assessments: [] }), { role: 'RESEARCHER', ...receipts() }), /exactly one assessment/);
});
