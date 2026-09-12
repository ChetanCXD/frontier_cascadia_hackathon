import { createHash } from 'node:crypto';

const TRACKING_KEYS = /^(utm_[a-z0-9_]+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|ref|referrer|source)$/i;

/** Return a stable HTTP URL key without fragments or common attribution parameters. */
export function canonicalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('url must be a non-empty string');
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new TypeError('url must be valid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('url must be HTTP(S)');
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
  parsed.username = '';
  parsed.password = '';
  const kept = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_KEYS.test(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  parsed.search = '';
  for (const [key, val] of kept) parsed.searchParams.append(key, val);
  parsed.hash = '';
  let path = parsed.pathname.replace(/\/+/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  parsed.pathname = path || '/';
  return parsed.toString();
}

export function normalizeText(value) {
  if (typeof value !== 'string') throw new TypeError('text must be a string');
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}
export function textFingerprint(value) {
  return createHash('sha256').update(normalizeText(value)).digest('hex');
}
export const fingerprintText = textFingerprint;
export function tokenSetSimilarity(a, b) {
  const left = new Set(tokenize(a)); const right = new Set(tokenize(b));
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0; for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}
export const textSimilarity = tokenSetSimilarity;
export const calculateSimilarity = tokenSetSimilarity;
export const similarity = tokenSetSimilarity;
export function quoteOverlap(quote, text) {
  const q = tokenize(quote); const t = new Set(tokenize(text));
  if (!q.length) return 0;
  return q.filter(token => t.has(token)).length / q.length;
}
export const calculateQuoteOverlap = quoteOverlap;

const PRIMARY_TYPES = new Set(['government', 'official', 'court', 'statute', 'regulatory', 'dataset', 'press-release', 'first-party', 'primary', 'academic', 'peer-reviewed', 'research', 'scientific']);
const SECONDARY_TYPES = new Set(['news', 'review', 'analysis', 'commentary', 'blog', 'secondary', 'aggregator']);
export function scoreSourceQuality(source = {}) {
  if (Number.isFinite(source.quality)) return Math.max(0, Math.min(100, source.quality));
  let score = 50;
  const type = String(source.sourceType ?? '').toLowerCase();
  if (PRIMARY_TYPES.has(type)) score += 25;
  if (SECONDARY_TYPES.has(type)) score -= 5;
  if (source.publisher && String(source.publisher).toLowerCase() !== 'unknown publisher') score += 10;
  if (source.author) score += 5;
  if (source.publishedAt) score += 5;
  if (source.title) score += 3;
  if (source.url || source.canonicalUrl) score += 2;
  return Math.max(0, Math.min(100, score));
}
export function inferSourceRole(source = {}) {
  const type = String(source.sourceType ?? '').toLowerCase();
  if (PRIMARY_TYPES.has(type)) return 'PRIMARY';
  if (SECONDARY_TYPES.has(type)) return 'SECONDARY';
  return scoreSourceQuality(source) >= 70 ? 'PRIMARY' : 'SECONDARY';
}
export const inferPrimarySecondary = inferSourceRole;
export const isPrimarySource = source => inferSourceRole(source) === 'PRIMARY';
export const sourceQualityScore = scoreSourceQuality;

/** Group exact canonical URLs; input records are not mutated. */
export function deduplicateSources(sources = []) {
  const groups = new Map();
  for (const source of sources) {
    const key = canonicalizeUrl(source.canonicalUrl ?? source.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  return [...groups.entries()].map(([canonicalUrl, records]) => ({ canonicalUrl, records: [...records] }));
}
export const deduplicateByCanonicalUrl = deduplicateSources;
