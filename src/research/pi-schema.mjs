import { URL } from 'node:url';
import { isIP } from 'node:net';

export const PI_ROLES = Object.freeze(['RESEARCHER', 'SKEPTIC', 'FOLLOW_UP']);
export const PI_EDGE_TYPES = Object.freeze(['SUPPORTS', 'CONTRADICTS', 'QUALIFIES']);
export const PI_ASSESSMENT_STATUSES = Object.freeze(['SUPPORTED', 'CONTRADICTED', 'MIXED', 'UNCERTAIN']);
const TOP_KEYS = new Set(['role', 'queries', 'sources', 'claims', 'edges', 'contradictions', 'qualifications', 'followUpReasons', 'assessments', 'finalConclusion']);
const SOURCE_KEYS = new Set(['url', 'title', 'publisher', 'author', 'publishedAt', 'excerpt', 'sourceType']);
const CLAIM_KEYS = new Set(['text']);
const EDGE_KEYS = new Set(['claimText', 'sourceUrl', 'type', 'confidence', 'quote']);
const NOTE_KEYS = new Set(['claimText', 'sourceUrl', 'quote']);
const ASSESSMENT_KEYS = new Set(['claimText', 'status', 'evidenceStrength', 'citations']);
const MAX = Object.freeze({ query: 500, source: 30, claim: 4000, excerpt: 4000, conclusion: 2000, arrays: 30 });

export class PiOutputError extends Error {
  constructor(message, code = 'invalid_pi_output') { super(message); this.name = 'PiOutputError'; this.code = code; }
}

function fail(message) { throw new PiOutputError(message); }
function plain(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`); return value; }
function array(value, field, max = MAX.arrays) { if (!Array.isArray(value) || value.length > max) fail(`${field} must be an array with at most ${max} items`); return value; }
function string(value, field, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters`); return value.trim(); }
function keys(value, allowed, field) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key} is not permitted`); }
function privateIpv4(host) {
  const octets = host.split('.').map(Number); if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets; return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19);
}
function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); const version = isIP(host);
  if (version === 4) return privateIpv4(host);
  if (version === 6) { if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true; if (host.startsWith('::ffff:')) return privateIpv4(host.slice(7)); return false; }
  return host === 'localhost' || host.endsWith('.local');
}
function url(value, field) {
  const text = string(value, field, 4096);
  try {
    const parsed = new URL(text); const host = parsed.hostname;
    if (!['http:', 'https:'].includes(parsed.protocol) || privateHost(host)) throw new Error();
    return parsed.href;
  } catch { fail(`${field} must be a public HTTP(S) URL`); }
}
function confidence(value, field) { if (!Number.isFinite(value) || value < 0 || value > 100) fail(`${field} must be between 0 and 100`); return value; }
function normalizedUrl(value) { try { const parsed = new URL(value); parsed.hash = ''; return parsed.href.replace(/\/$/, '').toLowerCase(); } catch { return ''; } }
function normalizedText(value) { return String(value).toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim(); }
function contentForUrl(observedContent, sourceUrl) {
  if (!observedContent) return [];
  const key = normalizedUrl(sourceUrl);
  if (observedContent instanceof Map) return observedContent.get(key) ?? [];
  if (typeof observedContent === 'object' && !Array.isArray(observedContent)) return observedContent[key] ?? [];
  return [];
}
function grounded(quote, excerpt, observedText, sourceUrl, observedContent) {
  const needle = normalizedText(quote); if (needle.length < 12) return false;
  const sourceTexts = contentForUrl(observedContent, sourceUrl);
  const haystacks = [excerpt, ...sourceTexts, ...(observedContent === undefined ? (observedText ?? []) : [])].map(normalizedText).filter(Boolean);
  return haystacks.some((haystack) => haystack.includes(needle));
}

export function validatePiResult(value, { role, observedUrls, observedText, observedContent } = {}) {
  const result = plain(value, 'result'); keys(result, TOP_KEYS, 'result');
  if (!PI_ROLES.includes(result.role) || (role && result.role !== role)) fail(`result.role must be ${role || PI_ROLES.join(', ')}`);
  const queries = array(result.queries, 'queries', 12).map((query, index) => string(query, `queries[${index}]`, MAX.query));
  if (!queries.length) fail('queries must contain at least one search query');
  const sources = array(result.sources, 'sources', 20).map((source, index) => {
    const item = plain(source, `sources[${index}]`); keys(item, SOURCE_KEYS, `sources[${index}]`);
    const parsed = { url: url(item.url, `sources[${index}].url`), title: string(item.title, `sources[${index}].title`, 500), publisher: string(item.publisher, `sources[${index}].publisher`, 300), excerpt: string(item.excerpt, `sources[${index}].excerpt`, MAX.excerpt), sourceType: item.sourceType === undefined ? 'web' : string(item.sourceType, `sources[${index}].sourceType`, 100) };
    if (item.author !== undefined) parsed.author = string(item.author, `sources[${index}].author`, 300);
    if (item.publishedAt !== undefined) parsed.publishedAt = string(item.publishedAt, `sources[${index}].publishedAt`, 100);
    if (observedUrls && ![...(observedUrls instanceof Set ? observedUrls : observedUrls)].map(normalizedUrl).includes(normalizedUrl(parsed.url))) fail(`sources[${index}].url was not returned by pi-web-search`);
    const sourceTexts = contentForUrl(observedContent, parsed.url);
    const excerptGrounded = observedContent !== undefined
      ? sourceTexts.map(normalizedText).some((haystack) => haystack.includes(normalizedText(parsed.excerpt)))
      : (observedText && observedText.map(normalizedText).some((haystack) => haystack.includes(normalizedText(parsed.excerpt))));
    if (observedText && !excerptGrounded) fail(`sources[${index}].excerpt is not present in retrieved Pi web content`);
    return parsed;
  });
  if (!sources.length) fail('sources must contain at least one retrieved source');
  const sourceUrls = new Set(sources.map((source) => normalizedUrl(source.url)));
  const claims = array(result.claims, 'claims', 20).map((claim, index) => { const item = plain(claim, `claims[${index}]`); keys(item, CLAIM_KEYS, `claims[${index}]`); return { text: string(item.text, `claims[${index}].text`, MAX.claim) }; });
  if (!claims.length) fail('claims must contain at least one atomic claim');
  const claimTexts = new Set(claims.map((claim) => claim.text));
  const parseEvidence = (edge, index, field = 'edges') => {
    const item = plain(edge, `${field}[${index}]`); keys(item, EDGE_KEYS, `${field}[${index}]`);
    const parsed = { claimText: string(item.claimText, `${field}[${index}].claimText`, MAX.claim), sourceUrl: url(item.sourceUrl, `${field}[${index}].sourceUrl`), type: string(item.type, `${field}[${index}].type`, 30).toUpperCase(), confidence: confidence(item.confidence, `${field}[${index}].confidence`), quote: string(item.quote, `${field}[${index}].quote`, MAX.excerpt) };
    if (!claimTexts.has(parsed.claimText)) fail(`${field}[${index}] references an unknown claim`);
    if (!sourceUrls.has(normalizedUrl(parsed.sourceUrl))) fail(`${field}[${index}] references an unknown source URL`);
    if (!PI_EDGE_TYPES.includes(parsed.type)) fail(`${field}[${index}].type must be SUPPORTS, CONTRADICTS, or QUALIFIES`);
    const source = sources.find((candidate) => normalizedUrl(candidate.url) === normalizedUrl(parsed.sourceUrl));
    if (!grounded(parsed.quote, source.excerpt, observedText, source.url, observedContent)) fail(`${field}[${index}].quote is not grounded in retrieved source text`);
    return parsed;
  };
  const edges = array(result.edges, 'edges', 60).map((edge, index) => parseEvidence(edge, index));
  if (!edges.length) fail('edges must contain at least one evidence relationship');
  const parseNote = (note, index, field) => {
    const item = plain(note, `${field}[${index}]`); keys(item, NOTE_KEYS, `${field}[${index}]`);
    const parsed = { claimText: string(item.claimText, `${field}[${index}].claimText`, MAX.claim), sourceUrl: url(item.sourceUrl, `${field}[${index}].sourceUrl`), quote: string(item.quote, `${field}[${index}].quote`, MAX.excerpt) };
    if (!claimTexts.has(parsed.claimText) || !sourceUrls.has(normalizedUrl(parsed.sourceUrl))) fail(`${field}[${index}] references an unknown entity`);
    const source = sources.find((candidate) => normalizedUrl(candidate.url) === normalizedUrl(parsed.sourceUrl));
    if (!grounded(parsed.quote, source.excerpt, observedText, source.url, observedContent)) fail(`${field}[${index}].quote is not grounded in retrieved source text`);
    return parsed;
  };
  const contradictions = array(result.contradictions, 'contradictions', 30).map((item, index) => parseNote(item, index, 'contradictions'));
  const qualifications = array(result.qualifications, 'qualifications', 30).map((item, index) => parseNote(item, index, 'qualifications'));
  const followUpReasons = array(result.followUpReasons, 'followUpReasons', 10).map((reason, index) => string(reason, `followUpReasons[${index}]`, 500));
  const assessments = array(result.assessments, 'assessments', 20).map((assessment, index) => {
    const item = plain(assessment, `assessments[${index}]`); keys(item, ASSESSMENT_KEYS, `assessments[${index}]`);
    const parsed = { claimText: string(item.claimText, `assessments[${index}].claimText`, MAX.claim), status: string(item.status, `assessments[${index}].status`, 30).toUpperCase(), evidenceStrength: confidence(item.evidenceStrength, `assessments[${index}].evidenceStrength`), citations: array(item.citations, `assessments[${index}].citations`, 20).map((citation, citationIndex) => url(citation, `assessments[${index}].citations[${citationIndex}]`)) };
    if (!claimTexts.has(parsed.claimText)) fail(`assessments[${index}] references an unknown claim`);
    if (!PI_ASSESSMENT_STATUSES.includes(parsed.status)) fail(`assessments[${index}].status is invalid`);
    if (!parsed.citations.length) fail(`assessments[${index}].citations must contain at least one URL`);
    if (parsed.citations.some((citation) => !sourceUrls.has(normalizedUrl(citation)))) fail(`assessments[${index}] contains an ungrounded citation URL`);
    return parsed;
  });
  if (!assessments.length || assessments.length !== claims.length) fail('assessments must contain exactly one assessment per claim');
  const assessedClaims = new Set(assessments.map((assessment) => assessment.claimText));
  if (assessedClaims.size !== claims.length) fail('assessments must not duplicate claims');
  if (claims.some((claim) => !assessedClaims.has(claim.text))) fail('every claim needs a final assessment');
  if (claims.some((claim) => !edges.some((edge) => edge.claimText === claim.text))) fail('every claim needs at least one evidence edge');
  const finalConclusion = string(result.finalConclusion, 'finalConclusion', MAX.conclusion);
  return { role: result.role, queries, sources, claims, edges, contradictions, qualifications, followUpReasons, assessments, finalConclusion };
}

export function normalizeObservedUrl(value) { return normalizedUrl(value); }
export function extractUrls(value) { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return [...new Set((text.match(/https?:\/\/[^\s\]}>"')]+/gi) ?? []).map((item) => item.replace(/[),.;]+$/, '')).map(normalizedUrl).filter(Boolean))]; }
export function extractText(value) { if (typeof value === 'string') return [value]; if (!value || typeof value !== 'object') return []; if (Array.isArray(value)) return value.flatMap(extractText); return Object.entries(value).flatMap(([key, item]) => key === 'text' || key === 'content' || key === 'answer' || key === 'excerpt' ? extractText(item) : []); }
